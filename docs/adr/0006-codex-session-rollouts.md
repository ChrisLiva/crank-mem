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
  `agent_message`/`user_message` content and can be ignored for mining.
- **Wrinkle**: one rollout file may hold multiple `session_meta` blocks —
  forked and sub-agent threads land in the parent's file — so "one file ≈ one
  session" is approximate. Consumers should treat the file, not the
  `session_meta`, as the batching unit.

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

Re-run after a Codex CLI upgrade — the store layout is undocumented and may
move (other stores exist beside it: `session_index.jsonl`, `history.jsonl`,
sqlite DBs; rollouts are the source of record for transcript mining).

## Decision

The `crank-mem-audit` skill mines Codex sessions from rollout files only,
filters by date directory plus the cwd grep, and batches per file (never
splitting a file) because of the multi-`session_meta` wrinkle.
