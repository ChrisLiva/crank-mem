import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { isObj, SENSITIVE_GLOBS, type Obj } from "../hooks/lib/config.ts";
import { crankHome, writeStopState } from "../hooks/lib/user-state.ts";

// The one door to the model: `claude -p` on the user's own Claude login,
// with a fixed call shape and an allowlisted environment (ADR 0008).

type Schema = {
  type?: string;
  enum?: readonly unknown[];
  required?: readonly string[];
  properties?: Record<string, Schema>;
  items?: Schema;
  additionalProperties?: boolean;
};

/** `T` is the shape `schema` describes: `classify` checks the output against `schema` before typing it as `T`. */
export type ModelRequest<T> = { system: string; input: string; schema: Schema };

/** Whether `value` fits `schema`, over the keywords the request schemas use; extra object keys pass. */
export function matchesSchema<T>(schema: Schema, value: unknown): value is T {
  if (schema.enum !== undefined && !schema.enum.includes(value)) return false;
  switch (schema.type) {
    case "object": {
      if (!isObj(value)) return false;
      const properties = Object.entries(schema.properties ?? {});
      return (
        (schema.required ?? []).every((key) => Object.hasOwn(value, key)) &&
        properties.every(
          ([key, sub]) => !Object.hasOwn(value, key) || matchesSchema(sub, value[key]),
        )
      );
    }
    case "array": {
      const items = schema.items;
      return (
        Array.isArray(value) && (items === undefined || value.every((v) => matchesSchema(items, v)))
      );
    }
    case "string":
      return typeof value === "string";
    case "integer":
      return Number.isInteger(value);
    default:
      return true;
  }
}

export type ModelResult<T> =
  | { kind: "ok"; output: T; model: string; costUsd: number }
  | { kind: "stopped"; reason: "credential" | "login"; detail: string }
  | { kind: "rejected"; detail: string }
  | { kind: "retry"; detail: string };

export const RUN_TIMEOUT_MS = 300_000;

const PASSED_ENV = ["HOME", "USER", "PATH", "TMPDIR"] as const;

type Failure = Exclude<ModelResult<unknown>, { kind: "ok" }>;
type Run = { code: number | null; stdout: string; failure: Failure | null };

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
function runClaude(
  args: string[],
  input: string | null,
  cwd: string,
  timeoutMs: number,
  watchKey = false,
): Promise<Run> {
  return new Promise((resolve) => {
    let stdout = "";
    let pending = "";
    let failure: Failure | null = null;
    const child = spawn("claude", args, {
      cwd,
      env: claudeEnv(),
      stdio: ["pipe", "pipe", "ignore"],
    });
    const fail = (f: Failure) => {
      failure ??= f;
      child.kill("SIGKILL");
    };
    const timer = setTimeout(
      () => fail({ kind: "retry", detail: `claude ${args[0]} ran past ${timeoutMs} ms` }),
      timeoutMs,
    );
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
      if (!watchKey) return;
      const lines = (pending + chunk).split("\n");
      pending = lines.pop() ?? "";
      for (const line of lines) {
        const parsed = parseJson(line);
        if (isObj(parsed) && "apiKeySource" in parsed && parsed.apiKeySource !== "none") {
          fail({
            kind: "stopped",
            reason: "credential",
            detail: `claude -p ran on apiKeySource ${String(parsed.apiKeySource)}, not the claude.ai login`,
          });
        }
      }
    });
    child.stdin.on("error", () => {});
    child.stdin.end(input ?? "");
    child.on("error", (err: NodeJS.ErrnoException) => {
      clearTimeout(timer);
      const detail =
        err.code === "ENOENT" ? "claude not found" : `claude did not start: ${err.message}`;
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

/**
 * The fixed call shape (ADR 0008). With a `project`, the run gets read-only tools over it, room for
 * their turns, and deny rules for the sensitive-file filter (ADR 0011).
 */
function callArgs(system: string, schema: Schema, project: string | null): string[] {
  const settings =
    project === null
      ? { disableAllHooks: true }
      : { disableAllHooks: true, permissions: { deny: SENSITIVE_GLOBS.map((g) => `Read(${g})`) } };
  return [
    "-p",
    "--model",
    "haiku",
    "--effort",
    "low",
    "--tools",
    project === null ? "" : "Read,Grep,Glob",
    "--setting-sources",
    "",
    "--settings",
    JSON.stringify(settings),
    "--strict-mcp-config",
    "--no-session-persistence",
    "--max-turns",
    project === null ? "2" : "40",
    "--system-prompt",
    system,
    "--json-schema",
    JSON.stringify(schema),
    "--output-format",
    "stream-json",
    "--verbose",
  ];
}

/** `<crank home>/run` is the empty cwd of a run that names no project. */
export const RUN_DIR = "run";

/**
 * One structured-output run on the user's Claude login, gated on `claude auth status`. Without `project`
 * both spawns run in an empty `<crank home>/run`; with it, both run in the project, since a deny rule
 * does not reach a directory passed by `--add-dir` (ADR 0011). A stopped result also writes the stop state.
 */
export async function askClaude<T>(
  req: ModelRequest<T>,
  opts: { timeoutMs?: number; project?: string } = {},
): Promise<ModelResult<T>> {
  const result = await askOnce(req, opts);
  if (result.kind === "stopped")
    writeStopState({ reason: result.reason, atMs: Date.now(), detail: result.detail });
  return result;
}

async function askOnce<T>(
  req: ModelRequest<T>,
  opts: { timeoutMs?: number; project?: string },
): Promise<ModelResult<T>> {
  const timeoutMs = opts.timeoutMs ?? RUN_TIMEOUT_MS;
  const project = opts.project ?? null;
  const cwd = project ?? path.join(crankHome(), RUN_DIR);
  if (project === null) fs.mkdirSync(cwd, { recursive: true, mode: 0o700 });

  const auth = await runClaude(["auth", "status"], null, cwd, timeoutMs);
  if (auth.failure) return auth.failure;
  const status = parseJson(auth.stdout);
  if (!isObj(status))
    return { kind: "retry", detail: `claude auth status printed no JSON (exit ${auth.code})` };
  if (status.loggedIn === false)
    return { kind: "stopped", reason: "login", detail: "claude auth status: not logged in" };
  if (
    status.loggedIn !== true ||
    status.authMethod !== "claude.ai" ||
    status.apiProvider !== "firstParty"
  ) {
    return {
      kind: "stopped",
      reason: "credential",
      detail: `claude auth status: authMethod ${String(status.authMethod)}, apiProvider ${String(status.apiProvider)}; digests run only on a claude.ai login`,
    };
  }

  const run = await runClaude(
    callArgs(req.system, req.schema, project),
    req.input,
    cwd,
    timeoutMs,
    true,
  );
  if (run.failure) return run.failure;
  return classify<T>(run, req.schema);
}

/** A `-p` run that failed on the login: "Not logged in" in failure text, or HTTP 401/403. */
function loginStop(run: Pick<Run, "stdout">, result: Obj | null): ModelResult<never> | null {
  // Only failure text counts: a non-JSON line or an error result's `result` (ADR 0008).
  // JSON lines also carry the digest's own text, which may quote the error.
  const plainText = run.stdout.split("\n").filter((line) => parseJson(line) === undefined);
  const errorText =
    result?.is_error === true && typeof result.result === "string" ? result.result : "";
  if ([...plainText, errorText].some((text) => text.includes("Not logged in"))) {
    return { kind: "stopped", reason: "login", detail: "claude -p: not logged in" };
  }
  if (result?.api_error_status === 401 || result?.api_error_status === 403) {
    return {
      kind: "stopped",
      reason: "login",
      detail: `claude -p: HTTP ${result.api_error_status}`,
    };
  }
  return null;
}

/** Settle a finished `-p` run. Credential failures also read `subtype: "success"` (ADR 0008), so `subtype` alone decides nothing. */
export function classify<T>(run: Pick<Run, "code" | "stdout">, schema: Schema): ModelResult<T> {
  const result = lastResult(run.stdout);
  const modelUsage = isObj(result?.modelUsage) ? result.modelUsage : {};
  const providers = Object.values(modelUsage)
    .filter(isObj)
    .map((u) => u.provider)
    .filter((p) => p !== undefined);
  const other = providers.find((p) => p !== "firstParty");
  if (other !== undefined)
    return {
      kind: "stopped",
      reason: "credential",
      detail: `claude -p ran on provider ${String(other)}`,
    };
  const login = loginStop(run, result);
  if (login) return login;
  if (!result)
    return { kind: "retry", detail: `claude -p printed no result line (exit ${run.code})` };
  if (result.is_error === true) {
    if (result.subtype === "error_max_turns")
      return { kind: "rejected", detail: "claude -p hit max turns without structured output" };
    return {
      kind: "retry",
      detail: `claude -p ended in an error (api_error_status ${String(result.api_error_status)}, exit ${run.code})`,
    };
  }
  if (result.structured_output === undefined || result.structured_output === null) {
    return { kind: "rejected", detail: "claude -p returned no structured output" };
  }
  if (!matchesSchema<T>(schema, result.structured_output))
    return { kind: "rejected", detail: "claude -p structured output failed the schema" };
  if (providers.length === 0)
    return { kind: "stopped", reason: "credential", detail: "claude -p result named no provider" };
  const costUsd = typeof result.total_cost_usd === "number" ? result.total_cost_usd : 0;
  return {
    kind: "ok",
    output: result.structured_output,
    model: Object.keys(modelUsage)[0]!,
    costUsd,
  };
}
