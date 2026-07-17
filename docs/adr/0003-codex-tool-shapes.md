# 0003 — Codex tool shapes in hook payloads (probe-verified)

Date: 2026-07-16. Status: accepted. Codex 0.144.5.

## Findings

- Codex has NO Read tool: file reads arrive as `tool_name: "Bash"` shell
  commands (`sed -n '1,200p' file` etc.), so a `Read` matcher never fires
  there. (OpenWolf's Codex re-index is silently broken for this reason.)
- Writes arrive as `tool_name: "apply_patch"` with `tool_input.command` = raw
  patch text: `*** Begin Patch` / `*** Add File:` / `*** Update File:` /
  `*** Delete File:` lines.
- Codex payloads otherwise mirror Claude's envelope (`session_id`,
  `transcript_path`, `cwd`, `hook_event_name`) plus `turn_id`, `model`,
  `permission_mode`.
- `.codex/hooks.json` schema equals Claude's settings shape: PascalCase event
  keys, `{matcher, hooks: [{type: "command", command, timeout}]}` — verified
  live.
- Claude Code subagent tool calls carry `agent_id` + `agent_type` in hook
  stdin; `session_id`/`transcript_path` are shared with the main loop (moot
  for v1, recorded for the future).

## Decision

Codex tier = session-start injection + `apply_patch` re-index only. No
Bash-command parsing for reads. The post-write hook parses apply_patch text
for Add/Update/Delete paths; Delete drops the index entry.
