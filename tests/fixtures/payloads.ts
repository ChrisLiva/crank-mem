// Captured hook payloads (live-probed 2026-07-16, Claude Code 2.1.212 /
// Codex 0.144.5). Shapes are real; ids and paths are anonymized. `cwd` is
// patched in by tests.

export function claudeSessionStart(cwd: string): object {
  return {
    session_id: "a46b6073-1111-2222-3333-444455556666",
    transcript_path: "/Users/u/.claude/projects/-proj/a46b6073.jsonl",
    cwd,
    hook_event_name: "SessionStart",
    source: "startup",
  };
}

export function codexSessionStart(cwd: string): object {
  return {
    session_id: "019f6e07-aaaa-bbbb-cccc-ddddeeeeffff",
    turn_id: "019f6e07-1111-2222-3333-444455556666",
    transcript_path: "/Users/u/.codex/sessions/019f6e07.jsonl",
    cwd,
    hook_event_name: "SessionStart",
    model: "gpt-5.6-sol",
    permission_mode: "bypassPermissions",
    source: "startup",
  };
}

export function claudePostWrite(cwd: string, filePath: string): object {
  return {
    session_id: "a46b6073-1111-2222-3333-444455556666",
    transcript_path: "/Users/u/.claude/projects/-proj/a46b6073.jsonl",
    cwd,
    prompt_id: "73c04d01-1111-2222-3333-444455556666",
    permission_mode: "default",
    effort: { level: "high" },
    hook_event_name: "PostToolUse",
    tool_name: "Write",
    tool_input: { file_path: filePath, content: "..." },
    tool_response: { type: "text", filePath },
    tool_use_id: "toolu_01AAAA",
  };
}

export function claudePostEdit(cwd: string, filePath: string): object {
  return {
    ...claudePostWrite(cwd, filePath),
    tool_name: "Edit",
    tool_input: { file_path: filePath, old_string: "a", new_string: "b" },
  };
}

export function codexApplyPatch(cwd: string, patchText: string): object {
  return {
    session_id: "019f6e07-aaaa-bbbb-cccc-ddddeeeeffff",
    turn_id: "019f6e07-1111-2222-3333-444455556666",
    transcript_path: "/Users/u/.codex/sessions/019f6e07.jsonl",
    cwd,
    hook_event_name: "PostToolUse",
    model: "gpt-5.6-sol",
    permission_mode: "bypassPermissions",
    tool_name: "apply_patch",
    tool_input: { command: patchText },
    tool_response: "Done",
    tool_use_id: "exec-01",
  };
}
