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

type Failure = Exclude<ModelResult<unknown>, { kind: "ok" }>;
type Run = { code: number | null; stdout: string; failure: Failure | null };
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

/**
 * Run `claude` to its close. `watchKey` kills the run at the first stream line naming an
 * `apiKeySource` other than "none": the call is already off the claude.ai login.
 */
function runClaude(args: string[], input: string | null, cwd: string, timeoutMs: number, watchKey = false): Promise<Run> {
  return new Promise((resolve) => {
    let stdout = "";
    let pending = "";
    let failure: Failure | null = null;
    const child = spawn("claude", args, { cwd, env: claudeEnv(), stdio: ["pipe", "pipe", "ignore"] });
    const fail = (f: Failure) => {
      failure ??= f;
      child.kill("SIGKILL");
    };
    const timer = setTimeout(() => fail({ kind: "retry", detail: `claude ${args[0]} ran past ${timeoutMs} ms` }), timeoutMs);
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
      if (!watchKey) return;
      const lines = (pending + chunk).split("\n");
      pending = lines.pop() ?? "";
      for (const line of lines) {
        const parsed = parseJson(line);
        if (isObj(parsed) && "apiKeySource" in parsed && parsed.apiKeySource !== "none") {
          fail({ kind: "stopped", reason: "credential", detail: `claude -p ran on apiKeySource ${String(parsed.apiKeySource)}, not the claude.ai login` });
        }
      }
    });
    child.stdin.on("error", () => {});
    child.stdin.end(input ?? "");
    child.on("error", (err: NodeJS.ErrnoException) => {
      clearTimeout(timer);
      const detail = err.code === "ENOENT" ? "claude not found" : `claude did not start: ${err.message}`;
      resolve({ code: null, stdout, failure: failure ?? { kind: "retry", detail } });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, failure });
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
  if (auth.failure) return auth.failure;
  const status = parseJson(auth.stdout);
  if (!isObj(status)) return { kind: "retry", detail: `claude auth status printed no JSON (exit ${auth.code})` };
  if (status.loggedIn === false) return { kind: "stopped", reason: "login", detail: "claude auth status: not logged in" };
  if (status.loggedIn !== true || status.authMethod !== "claude.ai" || status.apiProvider !== "firstParty") {
    return {
      kind: "stopped", reason: "credential",
      detail: `claude auth status: authMethod ${String(status.authMethod)}, apiProvider ${String(status.apiProvider)}; digests run only on a claude.ai login`,
    };
  }

  const run = await runClaude(callArgs(req.system, req.schema), req.input, cwd, timeoutMs, true);
  if (run.failure) return run.failure;
  return classify(run, req.validate);
}

/** Settle a finished `-p` run. Credential failures also read `subtype: "success"` (exp/c1), so `subtype` alone decides nothing. */
function classify<T>(run: Run, validate: (value: unknown) => value is T): ModelResult<T> {
  const result = lastResult(run.stdout);
  const modelUsage = isObj(result?.modelUsage) ? result.modelUsage : {};
  const providers = Object.values(modelUsage).filter(isObj).map((u) => u.provider).filter((p) => p !== undefined);
  const other = providers.find((p) => p !== "firstParty");
  if (other !== undefined) return { kind: "stopped", reason: "credential", detail: `claude -p ran on provider ${String(other)}` };
  // Raw stdout covers both the plain-text form (exp/d.out) and the result line's `result` string.
  if (run.stdout.includes("Not logged in")) {
    return { kind: "stopped", reason: "login", detail: "claude -p: not logged in" };
  }
  if (result?.api_error_status === 401 || result?.api_error_status === 403) {
    return { kind: "stopped", reason: "login", detail: `claude -p: HTTP ${result.api_error_status}` };
  }
  if (!result) return { kind: "retry", detail: `claude -p printed no result line (exit ${run.code})` };
  if (result.is_error === true) {
    if (result.subtype === "error_max_turns") return { kind: "rejected", detail: "claude -p hit max turns without structured output" };
    return { kind: "retry", detail: `claude -p ended in an error (api_error_status ${String(result.api_error_status)}, exit ${run.code})` };
  }
  if (result.structured_output === undefined || result.structured_output === null) {
    return { kind: "rejected", detail: "claude -p returned no structured output" };
  }
  if (!validate(result.structured_output)) return { kind: "rejected", detail: "claude -p structured output failed the schema" };
  if (providers.length === 0) return { kind: "stopped", reason: "credential", detail: "claude -p result named no provider" };
  const costUsd = typeof result.total_cost_usd === "number" ? result.total_cost_usd : 0;
  return { kind: "ok", output: result.structured_output, model: Object.keys(modelUsage)[0]!, costUsd };
}
