// Copied 2026-11-02 from live claude -p runs at Claude Code 2.1.316 (ADR 0008); session text, ids and paths replaced because this repo is public.
// Init lines keep the gating fields and drop the long slash-command, skill and plugin lists.
import type { Digest } from "../../src/daemon/digest-prompt.ts";

const SESSION = "00000000-1111-2222-3333-444444444444";
const MODEL = "claude-haiku-5-5";
const TOOL_USE = "toolu_00000000000000000000000000";
const MESSAGE = "msg_00000000000000000000000000";
const CWD = "/tmp/crank-home/run";

type Line = Record<string, unknown>;
const uuid = (n: number) => `00000000-0000-0000-0000-${String(n).padStart(12, "0")}`;
const lines = (all: Line[]) => all.map((line) => JSON.stringify(line));

/** `claude auth status` stdout, keeping only the gating keys (no account or path fields). */
const authStatus = (status: Line, exit: number) => ({ stdout: JSON.stringify(status, null, 2), exit });

export const AUTH_LOGGED_OUT = authStatus({ loggedIn: false, authMethod: "none", apiProvider: "firstParty" }, 1);
export const AUTH_OAUTH_TOKEN = authStatus({ loggedIn: true, authMethod: "oauth_token", apiProvider: "firstParty" }, 0);
export const AUTH_API_KEY = authStatus(
  { loggedIn: true, authMethod: "api_key", apiProvider: "firstParty", apiKeySource: "ANTHROPIC_API_KEY" }, 0,
);
export const AUTH_THIRD_PARTY = authStatus({ loggedIn: true, authMethod: "third_party", apiProvider: "bedrock" }, 0);

function init(apiKeySource: string, tools: string[], permissionMode = "default"): Line {
  return {
    type: "system", subtype: "init", cwd: CWD, session_id: SESSION, tools, mcp_servers: [], model: MODEL, permissionMode,
    apiKeySource, claude_code_version: "2.1.316", output_style: "default", uuid: uuid(1),
  };
}

function assistant(content: object[], n: number, extra: Line = {}): Line {
  return {
    type: "assistant",
    message: { model: MODEL, id: MESSAGE, type: "message", role: "assistant", content },
    parent_tool_use_id: null, session_id: SESSION, uuid: uuid(n), ...extra,
  };
}

/** The `<synthetic>` assistant line a failed login or key prints before its result. */
function authFailed(text: string, n: number, extra: Line = {}): Line {
  return {
    type: "assistant",
    message: {
      id: uuid(90), model: "<synthetic>", role: "assistant", stop_reason: "stop_sequence", stop_sequence: "",
      type: "message", content: [{ type: "text", text }],
    },
    parent_tool_use_id: null, session_id: SESSION, uuid: uuid(n), timestamp: "2026-01-02T03:04:05.000Z",
    error: "authentication_failed", is_api_error_message: true, ...extra,
  };
}

const rateLimit = (n: number): Line => ({
  type: "rate_limit_event",
  rate_limit_info: { status: "allowed", rateLimitType: "five_hour", isUsingOverage: false },
  session_id: SESSION, uuid: uuid(n),
});

const enforce = (n: number): Line => ({
  type: "user",
  message: { role: "user", content: [{ type: "text", text: "[structured-output-enforce] You MUST call the StructuredOutput tool to complete this request. Call this tool now." }] },
  parent_tool_use_id: null, session_id: SESSION, uuid: uuid(n), timestamp: "2026-01-02T03:04:06.000Z", isSynthetic: true,
});

const usage = (costUSD: number, extra: Line = { provider: "firstParty" }) => ({
  [MODEL]: { costUSD, contextWindow: 1000000, maxOutputTokens: 128000, canonicalModel: MODEL, ...extra, costBasis: "list" },
});

/** A compliant run: the line types and order of ADR 0008 probe plan/live.jsonl. */
export function okStream(digest: Digest): string[] {
  return okStreamOf(digest);
}

/** okStream carrying any structured output, so a test can send one the digest schema rejects. */
export function okStreamOf(output: object, result?: Line): string[] {
  return lines(okLines(output, result));
}

function okLines(output: object, result: Line = {}): Line[] {
  return [
    init("none", ["StructuredOutput"]),
    {
      type: "system", subtype: "thinking_tokens", estimated_tokens: 50, estimated_tokens_delta: 50,
      session_id: SESSION, uuid: uuid(2),
    },
    assistant([{ type: "thinking", thinking: "", signature: "c2lnbmF0dXJl" }], 3),
    assistant([{ type: "tool_use", id: TOOL_USE, name: "StructuredOutput", input: output }], 4),
    {
      type: "user",
      message: { role: "user", content: [{ tool_use_id: TOOL_USE, type: "tool_result", content: "Structured output provided successfully" }] },
      parent_tool_use_id: null, session_id: SESSION, uuid: uuid(5),
      tool_use_result: "Structured output provided successfully",
    },
    rateLimit(6),
    {
      type: "result", subtype: "success", is_error: false, api_error_status: null, num_turns: 2,
      result: JSON.stringify(output), stop_reason: "tool_use", session_id: SESSION, terminal_reason: "completed",
      total_cost_usd: 0.0123, structured_output: output, modelUsage: usage(0.0123), uuid: uuid(7), ...result,
    },
  ];
}

/** A failed run's result line: `subtype: "success"` with `is_error: true` (exp/c1, plan/bare). */
function errorResult(result: string, apiErrorStatus: number | null, n: number): Line {
  return {
    type: "result", subtype: "success", is_error: true, api_error_status: apiErrorStatus, num_turns: 1, duration_api_ms: 0,
    stop_reason: "stop_sequence", session_id: SESSION, total_cost_usd: 0, modelUsage: {}, permission_denials: [],
    terminal_reason: "api_error", result, uuid: uuid(n),
    ...(apiErrorStatus === null ? {} : { api_error_origin: "first_party" }),
  };
}

function rejectedKey(apiKeySource: string, status: number): Line[] {
  const text = "Invalid API key · Fix external API key";
  return [
    init(apiKeySource, [], "auto"),
    authFailed(text, 2, { request_id: "req_00000000000000000000000000", api_error_status: status, api_error_origin: "first_party" }),
    errorResult(text, status, 3),
  ];
}

/** ADR 0008 probe exp/c1.*: ANTHROPIC_API_KEY set to a bad key. Exits 1. */
export function badKeyStream(): string[] {
  return lines(rejectedKey("ANTHROPIC_API_KEY", 401));
}

/** ADR 0008 probe plan/bare.jsonl: no login and no key. Exits 1. */
export function notLoggedInStream(): string[] {
  const text = "Not logged in · Please run /login";
  return lines([init("none", []), authFailed(text, 2), errorResult(text, null, 3)]);
}

/** ADR 0008 probe exp/d.out: the same failure without stream-json, as plain stdout. Exits 1. */
export const NOT_LOGGED_IN_RAW = "Not logged in · Please run /login\n";

/** No probe produced a 403: this is badKeyStream behind an `apiKeySource: "none"` init with the status changed. Exits 1. */
export function status403Stream(): string[] {
  return lines(rejectedKey("none", 403));
}

/** status403Stream with a 401, the shape a rejected login would give; no probe produced it either. Exits 1. */
export function status401Stream(): string[] {
  return lines(rejectedKey("none", 401));
}

/** status403Stream with a 500: an API failure that is neither a login nor a credential problem. Exits 1. */
export function status500Stream(): string[] {
  return lines(rejectedKey("none", 500));
}

/** ADR 0008 probe plan/refuse2-1.jsonl: the model declines both turns, no structured_output key. Exits 0. */
export function refusalStream(): string[] {
  const text = "I will not produce structured output.";
  return lines([
    init("none", ["StructuredOutput"]),
    { type: "system", subtype: "thinking_tokens", estimated_tokens: 50, estimated_tokens_delta: 50, session_id: SESSION, uuid: uuid(2) },
    { type: "system", subtype: "thinking_tokens", estimated_tokens: 237, estimated_tokens_delta: 187, session_id: SESSION, uuid: uuid(3) },
    assistant([{ type: "thinking", thinking: "", signature: "c2lnbmF0dXJl" }], 4),
    assistant([{ type: "text", text }], 5),
    rateLimit(6),
    enforce(7),
    assistant([{ type: "text", text }], 8),
    {
      type: "result", subtype: "success", is_error: false, api_error_status: null, num_turns: 2, result: text,
      stop_reason: "end_turn", session_id: SESSION, terminal_reason: "completed", total_cost_usd: 0.00033099,
      modelUsage: usage(0.00033099), permission_denials: [], uuid: uuid(9),
    },
  ]);
}

/** ADR 0008 probe exp/b2.jsonl: a run at --max-turns 1 that never called the tool. Exits 1. */
export function maxTurnsStream(): string[] {
  return lines([
    init("none", ["StructuredOutput"]),
    assistant([{ type: "text", text: "Here is a short answer instead of the requested record." }], 2),
    rateLimit(3),
    enforce(4),
    {
      type: "result", subtype: "error_max_turns", is_error: true, num_turns: 2, errors: ["Reached maximum number of turns (1)"],
      stop_reason: "end_turn", session_id: SESSION, terminal_reason: "max_turns", total_cost_usd: 0.0002494,
      modelUsage: usage(0.0002494), permission_denials: [], uuid: uuid(5),
    },
  ]);
}

/** okStream whose structured_output fails the digest schema. */
export function invalidOutputStream(): string[] {
  return okStreamOf({ observations: "x" }, { structured_output: { observations: "x" } });
}

/** okStream on a provider other than firstParty. */
export function otherProviderStream(digest: Digest): string[] {
  return lines(okLines(digest, { modelUsage: usage(0.0123, { provider: "bedrock" }) }));
}

/** okStream whose modelUsage carries no provider key. */
export function noProviderStream(digest: Digest): string[] {
  return lines(okLines(digest, { modelUsage: usage(0.0123, {}) }));
}
