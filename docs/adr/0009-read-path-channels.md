# 0009 — Read-path hook channels: file history and digest triggers (probe-verified)

Date: 2026-11-03. Status: accepted.

## Context

crank-mem 0.8.0 stores digests of finished Claude Code sessions in `.crank/memory.db`. Agents
meet that memory at session start, and also when they read a file the store has observations
on: `src/hooks/post-read.ts` adds that file's newest lines. That hook, the SessionEnd and Stop
signals that feed the digest spool, and the detached daemon they start rest on hook behavior
that only live runs can settle:

- Which read-path events carry `additionalContext` to the model, in the main session and in a
  subagent?
- How often would a read hook fire, and can it open SQLite inside a hook's time budget?
- When does SessionEnd fire, and can a hook start a process that outlives it?
- Does a permission rule let agents run `crank-mem search` without a prompt?

## Versions

- Claude Code 2.1.316 (`claude --version`) for every stored probe under `.crank/crank-mem-v2/research/probes/stage1/`.
- Claude Code 2.1.317 (`claude --version` printed `2.1.317 (Claude Code)`) for the live sentinel reading on 2026-11-03, recorded in ADR 0001 → `## Re-verification 2026-11-03`.
- bun 1.4.4, node 26.13.0, macOS (Darwin 27.0.0).

Probe paths below are relative to `.crank/crank-mem-v2/research/probes/stage1/`. That
directory is gitignored local evidence and is not part of this repo.

## Findings

1. **Read-path channels reach the model.** `hookSpecificOutput.additionalContext` reached the
   model from SessionStart, PreToolUse `Read`, PostToolUse `Read` and PostToolUse `Bash`. In
   the 2026-11-03 live reading the model named all four sentinels after one Read and one
   `cat`. Inside a `general-purpose` subagent both tool events reached the subagent, which saw
   no SessionStart text: it reported the two sentinels its own Read call produced and none of
   the parent's. PreToolUse text lands after the file content, so it gives no earlier
   placement than PostToolUse (`read-probe/a/`, with `prompt.txt` and `logs/`).
2. **Bash does most of the reading.** Over 30 days `Read` made 3,243 of 29,918 reads (10.8%)
   and Bash readers the rest, and subagents made 86% of `Read` calls (2,800 of 3,243). A
   `Read|Bash` matcher fires about 40,832 times a month: `Read` 443 + 2,800 and `Bash all`
   6,385 + 31,204 (`read-probe/b/census.out` lines 4, 6, 13 and 15, with the Bash reads on
   lines 7 and 16; its `firings/month=3243` line counts `Read` only).
3. **SQLite fits a hook.** A hook that opens SQLite and selects 15 rows from 10,000 takes
   10.4 ms under bun and 125.8 ms under node. Both are medians of a read-write open on a clean
   WAL database, the mode read mode uses (`read-probe/c/matrix.out`).
4. **`readOnly: true` fails on a clean WAL database under bun.** With the `-wal` and `-shm`
   files absent it fails with errcode 14, "unable to open database file". Read mode in
   `src/hooks/lib/memory.ts` → `openMemory` therefore checks `fs.existsSync` first, then opens
   read-write and runs `PRAGMA query_only=ON` (`read-probe/c/modes.ts`, `read-probe/c/matrix.out`).
5. **Payload shapes.** The PostToolUse `Read` and `Bash` payloads carry `tool_name`,
   `tool_input` (`file_path` for Read, `command` for Bash), `cwd` and `transcript_path`. A
   subagent's payload adds top-level `agent_id` and `agent_type` and carries the parent's
   `transcript_path`. The test fixtures copy these shapes (`plan/bash-posttooluse.jsonl`,
   `read-probe/a/logs/POST.stdin.jsonl`).
6. **SessionEnd.** It fires on `-p` end, `/exit`, `/clear`, SIGTERM and a closed PTY, and not
   on SIGKILL. Its default time limit is 1.5 s, and `timeout: 10` in the wiring raises it. At
   SessionStart on `startup` and `clear` the transcript file does not exist yet (`hook-probe/`).
7. **A detached child outlives its hook.** A child spawned with `detached: true,
   stdio: "ignore"` and `.unref()` kept running after its hook exited, and the hook returned
   at once (`hook-probe/logs/signore1` to `signore3`; `e.mjs` for the detached child). An
   `"inherit"` spawn also returned, within 632 ms, in that probe (`hook-probe/logs/sinherit1`
   to `sinherit3`). The choice of `"ignore"` therefore rests on keeping the child off the
   hook's stdout, which is the model-visible channel, not on a measured hang.
8. **The allow rule.** `Bash(crank-mem *)` in `permissions.allow` lets `crank-mem search foo`
   run without a prompt, and does not match a call that names the binary by absolute path
   (`read-probe/d/logs/`, `read-probe/d/run.sh`).
9. **The narrowed recall rules.** On Claude Code 2.1.317, `Bash(crank-mem search *)`,
   `Bash(crank-mem timeline *)` and `Bash(crank-mem get *)` match quoted arguments, flags and
   no arguments, and other subcommands still prompt. With a fake `crank-mem` on `PATH`,
   `claude -p '<run 6 commands>' --model haiku --settings '{"permissions":{"allow":["Bash(crank-mem search *)","Bash(crank-mem timeline *)","Bash(crank-mem get *)"]}}' --setting-sources "" --strict-mcp-config --no-session-persistence --permission-mode default --output-format json`
   exited 0 and ran `crank-mem search "auth flow" --limit 3`, `crank-mem timeline 12 --depth 2`,
   `crank-mem get 12 13` and `crank-mem search`; its `permission_denials` were
   `crank-mem digest on` and `crank-mem setup`. The probe passes the rules with `--settings`
   because `claude -p` ignores a project's own `permissions.allow` in an untrusted workspace:
   the same run with the rules in `.claude/settings.json` printed `Ignoring 3
   permissions.allow entries from .claude/settings.json: this workspace has not been
   trusted.` on stderr. The narrowed rules replace the legacy `Bash(crank-mem *)`, which
   pre-approved every subcommand, including `digest on` and `setup`.

## Decision

- File history is a PostToolUse hook on `Read|Bash`, `src/hooks/post-read.ts`, wired for
  Claude only. PostToolUse is the only read-path placement: PreToolUse text lands at the same
  point (Finding 1). The hook adds at most 5 lines per file and 1,536 bytes per call, once per
  file per agent per session, keyed by the transcript stem and `agent_id` under
  `<crank home>/seen/`.
- For Bash, `src/hooks/lib/shell-reads.ts` → `shellReadPaths` names the files a command reads
  with a plain read tool. crank-mem parses Bash for Claude sessions only, so ADR 0003's "No
  Bash-command parsing for reads" stands for Codex.
- Read mode opens `memory.db` read-write with `PRAGMA query_only=ON` after `fs.existsSync`,
  never with `readOnly: true` (Finding 4). A missing store prints nothing.
- SessionEnd and Stop write the session's spool entry (`src/hooks/lib/spool.ts` →
  `signalDigest`), with `timeout: 10` on the SessionEnd wiring. Neither prints anything for
  it. The daemon starts as a detached child with `stdio: "ignore"` and `.unref()` (Finding 7).
- `init` and `upgrade` add `Bash(crank-mem search *)`, `Bash(crank-mem timeline *)` and
  `Bash(crank-mem get *)` to the wired Claude settings file's `permissions.allow`, dropping
  a legacy `Bash(crank-mem *)` there and keeping the user's other rules in place, and
  `uninstall` removes all four (Findings 8 and 9).

Amended 2026-11-04: `init` and `upgrade` also add `Bash(crank-mem outline *)` and
`Bash(crank-mem unfold *)`, in Finding 9's form, after the three recall rules.
`shellReadPaths` names the file a `crank-mem outline` or `crank-mem unfold` call reads: the
first word after the subcommand that is not a flag and not the value of `--from`, so such a
call gets the same file history as a Read. `uninstall` removes all six rules: the five in
`CRANK_ALLOW_RULES` and the legacy `Bash(crank-mem *)`.

Amended 2026-11-12: the cross-repo memory spec raises a PostToolUse call's whole
`additionalContext` to under 4,096 bytes, to make room for the pair-reached history sections
and one cerebrum excerpt. File history itself keeps its limits of 5 lines per file and
1,536 bytes for all history sections together. After the history, `post-read.ts` adds at most
one excerpt block, the 2,048-byte balanced excerpt of the first project in the call's read order
that owns a read file, is not the start project, and has not had its excerpt shown to this agent
in this session. The hook records the shown excerpt as a `cerebrum:<root>` line in the same seen
marker it uses for file paths.

## Re-probe method (~10 min when `claude --version` changes minor version)

1. In a scratch project outside any repo, write a hook script per event that discards stdin
   and prints `{"hookSpecificOutput":{"hookEventName":"<event>","additionalContext":"Sentinel <WORD>."}}`
   with a distinct word for SessionStart, PreToolUse `Read`, PostToolUse `Read` and
   PostToolUse `Bash`. Wire them only in that project's `.claude/settings.local.json`.
2. Put a one-line text file in the project. Run
   `claude -p --model haiku --allowedTools Read "Bash(cat *)"` from it through
   `read-probe/cl.sh`, which strips the parent session's variables, with a prompt that has
   the model Read the file, run one `cat`, then answer "what sentinels do you see?".
3. Record which sentinels it names and `claude --version` in ADR 0001. For the subagent
   reading, rerun `read-probe/a/prompt.txt`, which spawns one `general-purpose` subagent.
4. For SessionEnd and the detached child, rerun the `hook-probe/` settings and read
   `hook-probe/logs/*/events.jsonl` and `spawn.log`. For the allow rules, put a fake
   `crank-mem` on `PATH` and run Finding 9's `claude -p` command, which passes the three
   recall rules through `--settings`; expect the recall calls to run and `digest on` and
   `setup` in `permission_denials`.
5. Delete the scratch project afterwards.
