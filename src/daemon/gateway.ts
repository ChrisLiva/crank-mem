import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { crankHome } from "../hooks/lib/user-state.ts";

// The one door to the model: `claude -p` on the user's own Claude login,
// with a fixed call shape and an allowlisted environment (ADR 0008).

export type ModelResult<T> =
  | { kind: "ok"; output: T; model: string; costUsd: number }
  | { kind: "stopped"; reason: "credential" | "login"; detail: string }
  | { kind: "rejected"; detail: string }
  | { kind: "retry"; detail: string };

export const RUN_TIMEOUT_MS = 300_000;

const PASSED_ENV = ["HOME", "USER", "PATH", "TMPDIR"] as const;

type Run = { code: number | null; stdout: string; detail: string | null };
type Obj = Record<string, unknown>;

const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);

/** Only these variables reach `claude`: a denylist misses credential routes (ADR 0008). */
function claudeEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const key of PASSED_ENV) {
    const value = process.env[key];
    if (value !== undefined) env[key] = value;
  }
  env.CLAUDE_CODE_MAX_RETRIES = "0";
  return env;
}

function runClaude(args: string[], input: string | null, cwd: string, timeoutMs: number): Promise<Run> {
  return new Promise((resolve) => {
    let stdout = "";
    let detail: string | null = null;
    const child = spawn("claude", args, { cwd, env: claudeEnv(), stdio: ["pipe", "pipe", "ignore"] });
    const timer = setTimeout(() => {
      detail ??= `claude ${args[0]} ran past ${timeoutMs} ms`;
      child.kill("SIGKILL");
    }, timeoutMs);
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => { stdout += chunk; });
    child.stdin.on("error", () => {});
    child.stdin.end(input ?? "");
    child.on("error", (err) => {
      clearTimeout(timer);
      resolve({ code: null, stdout, detail: `claude did not start: ${err.message}` });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, detail });
    });
  });
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

function lastResult(stdout: string): Obj | null {
  let found: Obj | null = null;
  for (const line of stdout.split("\n")) {
    const parsed = parseJson(line);
    if (isObj(parsed) && parsed.type === "result") found = parsed;
  }
  return found;
}

function callArgs(system: string, schema: object): string[] {
  return [
    "-p", "--model", "haiku", "--effort", "low", "--tools", "", "--setting-sources", "",
    "--settings", JSON.stringify({ disableAllHooks: true }), "--strict-mcp-config", "--no-session-persistence",
    "--max-turns", "2", "--system-prompt", system, "--json-schema", JSON.stringify(schema),
    "--output-format", "stream-json", "--verbose",
  ];
}

/** One structured-output run on the user's Claude login, gated on `claude auth status`. */
export async function askClaude<T>(
  req: { system: string; input: string; schema: object; validate: (value: unknown) => value is T },
  opts: { timeoutMs?: number } = {},
): Promise<ModelResult<T>> {
  const timeoutMs = opts.timeoutMs ?? RUN_TIMEOUT_MS;
  const cwd = path.join(crankHome(), "run");
  fs.mkdirSync(cwd, { recursive: true, mode: 0o700 });

  const auth = await runClaude(["auth", "status"], null, cwd, timeoutMs);
  if (auth.detail) return { kind: "retry", detail: auth.detail };
  const status = parseJson(auth.stdout);
  if (!isObj(status) || status.loggedIn !== true || status.authMethod !== "claude.ai" || status.apiProvider !== "firstParty") {
    return { kind: "retry", detail: `claude auth status did not show a claude.ai login (exit ${auth.code})` };
  }

  const run = await runClaude(callArgs(req.system, req.schema), req.input, cwd, timeoutMs);
  if (run.detail) return { kind: "retry", detail: run.detail };
  const result = lastResult(run.stdout);
  if (!result) return { kind: "retry", detail: `claude -p printed no result line (exit ${run.code})` };
  const model = isObj(result.modelUsage) ? Object.keys(result.modelUsage)[0] : undefined;
  if (result.is_error !== false || model === undefined || typeof result.total_cost_usd !== "number" || !req.validate(result.structured_output)) {
    return { kind: "retry", detail: `claude -p ended without valid output (exit ${run.code})` };
  }
  return { kind: "ok", output: result.structured_output, model, costUsd: result.total_cost_usd };
}
