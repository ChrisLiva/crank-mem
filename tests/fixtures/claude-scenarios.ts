// Copied 2026-11-02 from live claude -p runs at Claude Code 2.1.316 (ADR 0008); session text, ids and paths replaced because this repo is public.
import type { Digest } from "../../src/daemon/digest-prompt.ts";

const SESSION = "00000000-1111-2222-3333-444444444444";
const MODEL = "claude-haiku-5-5";
const TOOL_USE = "toolu_00000000000000000000000000";
const MESSAGE = "msg_00000000000000000000000000";

/** A compliant run: the line types and order of research/probes/stage1/plan/live.jsonl. */
export function okStream(digest: Digest): string[] {
  const assistant = (content: object[]) => ({
    type: "assistant",
    message: { model: MODEL, id: MESSAGE, type: "message", role: "assistant", content },
    parent_tool_use_id: null,
    session_id: SESSION,
    uuid: "00000000-0000-0000-0000-000000000003",
  });
  return [
    {
      type: "system", subtype: "init", cwd: "/tmp/crank-home/run", session_id: SESSION,
      tools: ["StructuredOutput"], mcp_servers: [], model: MODEL, permissionMode: "default",
      apiKeySource: "none", claude_code_version: "2.1.316", uuid: "00000000-0000-0000-0000-000000000001",
    },
    {
      type: "system", subtype: "thinking_tokens", estimated_tokens: 50, estimated_tokens_delta: 50,
      session_id: SESSION, uuid: "00000000-0000-0000-0000-000000000002",
    },
    assistant([{ type: "thinking", thinking: "", signature: "c2lnbmF0dXJl" }]),
    assistant([{ type: "tool_use", id: TOOL_USE, name: "StructuredOutput", input: digest }]),
    {
      type: "user",
      message: { role: "user", content: [{ tool_use_id: TOOL_USE, type: "tool_result", content: "Structured output provided successfully" }] },
      parent_tool_use_id: null, session_id: SESSION, uuid: "00000000-0000-0000-0000-000000000004",
      tool_use_result: "Structured output provided successfully",
    },
    {
      type: "rate_limit_event",
      rate_limit_info: { status: "allowed", rateLimitType: "five_hour", isUsingOverage: false },
      session_id: SESSION, uuid: "00000000-0000-0000-0000-000000000005",
    },
    {
      type: "result", subtype: "success", is_error: false, api_error_status: null, num_turns: 2,
      result: JSON.stringify(digest), stop_reason: "tool_use", session_id: SESSION, terminal_reason: "completed",
      total_cost_usd: 0.0123, structured_output: digest,
      modelUsage: {
        [MODEL]: { provider: "firstParty", costBasis: "list", costUSD: 0.0123, contextWindow: 1000000, maxOutputTokens: 128000 },
      },
      uuid: "00000000-0000-0000-0000-000000000006",
    },
  ].map((line) => JSON.stringify(line));
}
