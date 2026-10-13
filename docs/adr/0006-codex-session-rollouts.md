# 0006 — Codex session rollouts: location, filtering, message shape (probe-verified)

Date: 2026-08-14. Status: accepted. Probed against the live `~/.codex/sessions`
store on this machine (Codex CLI in daily use across several projects).

## Findings

- **Location**: `~/.codex/sessions/YYYY/MM/DD/rollout-<ISO-timestamp>-<uuid>.jsonl`.
  The date is in both the directory path and the filename, so time-window
  filtering needs no file parsing — walk the date directories.
- **Project filtering**: `grep -l '"cwd":"<abs project path>"'` over candidate
  files. The literal matches `session_meta` and `turn_context` records, whose
  payloads carry `payload.cwd` as an absolute path. Verified: 58 hits on a
  project with real Codex use; 0 hits for projects Codex never opened.
- **Messages**: `response_item` records with `payload.type == "message"`
  (role at `payload.role`, one of `user`, `assistant`, `developer`) or
  `payload.type == "agent_message"` (sub-agent final answers, with
  author/recipient thread paths instead of a role); both carry text at
  `payload.content[].text`. Sampled across 10 files / 874 `response_item`
  records: 103 `message`, 18 `agent_message`, the rest `reasoning` and
  `custom_tool_call`. A parallel `event_msg` stream duplicates
  `agent_message`/`user_message` content and can be ignored for mining
  messages, but not edits (amended 2026-10-13, same 31 rollouts as below):
  all 548 `custom_tool_call` records are named `exec` and none is a top-level
  `apply_patch`, and a file edit appears only as an `event_msg` record with
  `payload.type == "item_completed"` whose `payload.item.type` is `FileChange`
  (31 records). ADR 0007 probed that PostToolUse still fires with
  `tool_name: "apply_patch"` for a patch issued inside `exec`.
- **Wrinkle** (amended 2026-10-13, the 31 rollouts below): sub-agent threads get
  their own rollout files; they do not land in the parent's file, as first
  recorded here. 23 of the 31 files are sub-agent threads and 8 are root
  threads, so a file count overstates sessions 3.9x. 5 of the 23 sub-agent
  files also embed a second `session_meta`, the parent's (4 `user`, 1
  `code_review`), so only a file's FIRST `session_meta` names its own thread.
  Consumers should still treat the file as the batching unit, and classify
  it by its first `session_meta`.
- **Root threads** (amended 2026-10-13, 31 OrcaSlicer rollouts on Codex
  0.151.0 to 0.159.2): the FIRST `session_meta` of a sub-agent file carries
  `parent_thread_id` and `thread_source: "subagent"`; a root thread's carries
  neither (`thread_source` is `user` or `code_review`). A thread the user never
  prompted, such as an aborted code review, holds no `turn_context` record.
- **Hook context** (same date): crank's SessionStart injection is a
  `response_item` developer message whose first content item's `text` starts
  with `## crank-mem (project memory)`, on 0.144.5 and 0.159.2 alike; 0.159.2
  also tags it `content_item_kinds: ["hooks.additional_context"]`.
  `crank-mem stats` counts root threads with a turn and no such message.

The Claude Code counterpart (transcripts under
`~/.claude/projects/<project-slug>/*.jsonl`) is already recorded in ADR 0005.

## Probe method

Run on 2026-08-14, this machine:

1. `ls ~/.codex/sessions/` and drill into a date directory to confirm the
   `YYYY/MM/DD/rollout-<ISO-ts>-<uuid>.jsonl` layout.
2. `head` a rollout file to inspect record shapes, then enumerate
   `payload.type` values across ~10 sampled files to get the
   `message`/`agent_message`/`reasoning`/`custom_tool_call` split and confirm
   the `payload.cwd` / `payload.content[].text` fields named above.
3. `grep -l '"cwd":"<abs path>"' ~/.codex/sessions/*/*/*/rollout-*.jsonl`
   with a real project path (58 files) and an unused project path (0 files).

The 2026-10-13 amendments parsed every rollout whose text holds
`"cwd":"<OrcaSlicer path>"` (31 files) and counted files by the first
`session_meta`'s `thread_source` and `cli_version`, `session_meta` blocks per
file, `custom_tool_call` and `function_call` records by `name`, and
`event_msg` `item_completed` records by `payload.item.type`.

Re-run after a Codex CLI upgrade — the store layout is undocumented and may
move (other stores exist beside it: `session_index.jsonl`, `history.jsonl`,
sqlite DBs; rollouts are the source of record for transcript mining).

## Decision

The `crank-mem-audit` skill mines Codex sessions from rollout files only,
filters by date directory plus the cwd grep, and batches per file (never
splitting a file) because of the multi-`session_meta` wrinkle. `crank-mem
stats` classifies each file as a root or sub-agent thread by its first
`session_meta` (`src/cli/codex-sessions.ts`).
