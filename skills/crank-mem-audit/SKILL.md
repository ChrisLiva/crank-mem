---
name: crank-mem-audit
description: Audit and prune this project's crank-mem memory (.crank/cerebrum.md, journal.md) against recent agent sessions.
disable-model-invocation: true
---

# crank-mem-audit

Reconcile this project's crank-mem memory with reality: mine the last 10 days
of Claude Code and Codex sessions for durable learnings, verify every memory
claim against the current codebase, then back up and rewrite
`.crank/cerebrum.md` and `.crank/journal.md`.

Hard rule: memory files never receive secrets. Tokens, keys, credentials, and
connection strings seen in transcripts stay out of cerebrum and journal —
record that credentials exist ("auth uses an API key from env") without the
values.

## 1. Preflight

`.crank/config.json` must exist at the project root. If it does not, tell the
user to run `crank-mem init` first, and stop — write nothing.

## 2. Collect sessions

Gather this project's transcripts from the last 10 days:

- **Claude Code**: `~/.claude/projects/<slug>/*.jsonl`, where `<slug>` is the
  project's absolute path with every non-alphanumeric character replaced by
  `-`. Keep files modified within the window.
- **Codex**: `~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl` — the date
  directories give the time window without parsing anything. Keep only this
  project's files: `grep -l '"cwd":"<absolute project path>"'` over the
  candidates.

No transcripts in the window → report "nothing to audit" and stop.

## 3. Fan out miners

Split the transcript files into batches — one subagent per batch, at most ~8
subagents. Batch per file, never splitting one file across batches: a single
Codex rollout file may hold several forked or sub-agent `session_meta`
threads. Each subagent reads its batch and returns structured findings, not
transcript excerpts:

- corrections the user made,
- gotchas discovered about the codebase or tooling,
- decisions taken, with their reasons,
- wrong turns caused by stale or wrong memory (each one marks a bullet to
  prune).

Codex message extraction: `response_item` records with `payload.type` of
`"message"` (role at `payload.role`: user / assistant / developer) or
`"agent_message"` (sub-agent answers); both carry text at
`payload.content[].text`. Claude Code transcripts are ordinary message JSONL.

## 4. Verify against the code

Every cerebrum bullet — existing or newly mined — gets a spot-check against
the current codebase: read the file it names, run the command it cites.
Contradicted or unverifiable → prune. Only verified claims enter the rewrite.

## 5. Back up

Copy the current `cerebrum.md` and `journal.md` to
`.crank/backups/<timestamp>/` — plain copies only, no `manifest.json`
(`uninstall --restore` restores from the newest backup dir that has a
manifest; writing one would make it restore from the audit's backup instead
of init's). Do this before writing anything.

## 6. Rewrite

- **cerebrum.md** — rewrite densely: telegram-style bullets under the file's
  existing headings, deduplicated, verified facts only.
- **journal.md** — trim dead entries while keeping the format the hooks
  expect: one dated bullet per entry (`- YYYY-MM-DD — …`), newest last, at
  most 20 entries, and the newest `NEXT:` handoff kept intact — it is what
  the next session is shown.
- **anatomy.md and the index belong to the scanner.** If the index looks
  stale, suggest `crank-mem scan`; anatomy.md is rendered from the machine
  index and overwritten on the next scan, so hand-edits are lost.

## 7. Report

Summarize what was pruned, added, and kept — with reasons for the cuts — and
give the backup path.
