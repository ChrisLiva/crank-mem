# 0012 — Agent shell identity: who ran a CLI command (probe-verified)

Date: 2026-11-05. Status: accepted.

## Context

crank-mem 0.11.0 writes one usage line to `.crank/usage.jsonl` per recall or code command
(`crank-mem search`, `timeline`, `get`, `outline`, `unfold`), so the dashboard's Usage view
can tell an agent's calls from a person's and link a call to the session that made it. Hooks
read the agent and session from their stdin payload. A CLI command gets no payload: it runs in
a shell, either one that Claude Code's Bash tool started or a person's own terminal. Only the
environment that shell inherits can tell the two apart, and only a live run settles which
variables Claude Code exports there:

- Is `CLAUDECODE` set in the Bash tool of a main session, and of a subagent?
- Is `CLAUDE_CODE_SESSION_ID` set in both, so a usage line can name its session?

## Versions

- Claude Code 2.1.318 (`claude --version` printed `2.1.318 (Claude Code)`) for every reading
  below, all taken on 2026-11-05.
- bun 1.4.4, node 26.13.0, macOS 27.0.1 (Darwin 27.0.0).

## Findings

Every reading ran this command from a scratch directory outside the repo. The `sed` step
replaces the session id value, so no reading records it:

```sh
env | grep -E '^(CLAUDECODE|CLAUDE_CODE_SESSION_ID)=' | sed -E 's/(SESSION_ID=).*/\1<redacted>/'; claude --version
```

1. **Main session (the planner's reading).** The planner ran the probe in the Bash tool of its
   main session and read `CLAUDECODE=1` and `CLAUDE_CODE_SESSION_ID=<redacted>` on Claude
   Code 2.1.318.
2. **Main session (the execute coordinator's reading).** The execute coordinator re-ran the
   probe in the Bash tool of its main session and printed:

   ```
   CLAUDECODE=1
   CLAUDE_CODE_SESSION_ID=<redacted>
   2.1.318 (Claude Code)
   ```

3. **Subagent (plan-review subagents).** The plan-review subagents re-ran the probe in their
   own Bash tools and printed:

   ```
   CLAUDECODE=1
   CLAUDE_CODE_SESSION_ID=<redacted>
   2.1.318 (Claude Code)
   ```

4. **Subagent (the Task 7 implementer).** The implementer, a `general-purpose` subagent of the
   execute coordinator, ran the probe in its own Bash tool and printed:

   ```
   CLAUDECODE=1
   CLAUDE_CODE_SESSION_ID=<redacted>
   2.1.318 (Claude Code)
   ```

5. **Nested subagent.** A `general-purpose` subagent that the implementer spawned, two levels
   below the main session, ran the probe in its own Bash tool and printed:

   ```
   CLAUDECODE=1
   CLAUDE_CODE_SESSION_ID=<redacted>
   2.1.318 (Claude Code)
   ```

Claude Code therefore exports both variables to every Bash tool shell, at any subagent depth.
No reading here covers a shell that Claude Code did not start; step 4 of the re-probe method
takes that reading.

## Decision

- A CLI usage line takes `agent: "claude"` and `session: $CLAUDE_CODE_SESSION_ID` when
  `CLAUDECODE` is non-empty, and `agent: "manual"`, `session: null` otherwise
  (`src/hooks/lib/usage.ts` → `cliActor`). An empty `CLAUDECODE` counts as unset, so a test
  that runs inside Claude Code can pass `CLAUDECODE: ""` to stand for a person's terminal.
- An empty or absent `CLAUDE_CODE_SESSION_ID` with `CLAUDECODE` set records `session: null`,
  never an empty string. The line still records `agent: "claude"`.
- Codex shell detection waits for stage 6. Until then a recall command that Codex runs records
  `agent: "manual"`, while a Codex SessionStart line already records `agent: "codex"` from its
  payload.

## Re-probe method (~10 min when `claude --version` changes minor version)

1. Make an empty scratch directory outside any repo.
2. In a Claude Code main session, have the Bash tool `cd` into it and run the command under
   `## Findings`. Record its output verbatim and the context it ran in.
3. Spawn one `general-purpose` subagent and have it run the same command from the same
   directory through its own Bash tool. Record that output too.
4. Run the command once from a plain terminal outside Claude Code; expect no `CLAUDECODE` or
   `CLAUDE_CODE_SESSION_ID` line, only the version.
5. If `CLAUDECODE` is unset in either Claude Code context, or `CLAUDE_CODE_SESSION_ID` is
   missing from one, re-decide `cliActor` before shipping and amend this ADR. Delete the
   scratch directory afterwards.
