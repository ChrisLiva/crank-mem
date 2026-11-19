# 0018 — No per-prompt memory push: the UserPromptSubmit probe and prompt replays (probe-verified)

Date: 2026-11-18. Status: accepted.

## Context

ADR 0014 re-opened a deferred idea: a UserPromptSubmit hook that searches the memory store with
the user's prompt and injects what it finds, so memory reaches the agent at the moment a task is
stated. The usage lines still show agents asking for memory almost never (4 `search` lines in 8
days) while the sections crank-mem pushes on a file read are seen thousands of times, so a push
at prompt time looked like the next step.

Two facts decide whether it is worth building. The first is about Claude Code: does a
UserPromptSubmit hook's `hookSpecificOutput.additionalContext` reach the model, and what does
the payload hold? The second is about the content: when the hook searches with a real prompt,
is what comes back about that prompt? An off-topic push costs more than its bytes. codegraph's
per-prompt hook fired on keyword matches against unrelated symbols and taught the agent to skim
it, and claude-mem turned per-prompt injection off by default for off-topic results (observation
#120 in this project's store). crank-mem's file-history sections share that channel's
credibility.

This ADR records the channel probe, three replays of a prompt-time search over this project's
real prompts, and the decision that rests on them.

## Versions

- Claude Code 2.1.327, model alias `haiku` (the run reported `claude-haiku-5-5`), claude.ai
  login.
- bun 1.4.4, macOS (Darwin 27.2.0).
- crank-mem 0.16.0 at 3e4a2cb; this project's `memory.db` held 369 observations and its
  `code.db` 280 files.

The probe project, the replay scripts and their output lived in a scratch directory outside the
repo and are not part of it.

## Method

**Channel probe.** A scratch git project holds one `README.md` (`# scratch`) and a
`.claude/settings.local.json` that wires one hook:

```json
{"hooks":{"UserPromptSubmit":[{"hooks":[{"type":"command","command":"<scratch>/hook.sh","timeout":10}]}]}}
```

`hook.sh` copies its stdin to a log file and prints one line:

```json
{"hookSpecificOutput":{"hookEventName":"UserPromptSubmit","additionalContext":"Project note: the deploy codeword for this project is ZEBRA-7731."}}
```

No file in the project holds the codeword. The run, from the project directory, once with the
hook wired and once with the settings file moved away as a control:

```sh
env -i HOME="$HOME" USER="$USER" TMPDIR="$TMPDIR" PATH="$PATH" \
  claude -p --model haiku --setting-sources project,local --output-format json \
  "What is the deploy codeword for this project? Answer with the codeword only, or the single word unknown if you do not know it." </dev/null
```

**Prompts.** The replays read the typed user prompts of this project's main-session transcripts
from 2026-11-10 to 2026-11-18: records of type `user` that are not meta, not from a subagent,
hold only text, and do not start with `<` or `[` (tool results, command wrappers and compaction
summaries). Pasted blocks are cut from the prompt text. That leaves 140 prompts.

**Replay 1, a strict gate.** A prompt passes when one of its words names something the code
graph holds: a word with a slash or a file extension that matches exactly one indexed file by
path suffix, or an identifier-shaped word (`src/hooks/lib/shell-reads.ts` →
`IDENTIFIER_SHAPED`) that is the name of exactly one function, method or class in `code.db`.

**Replay 2, a search with no gate.** Each prompt with 4 or more content terms (not stop words)
is the query of the store's own `search`, limited to observations created before the prompt,
and the top 3 results are kept. It ran twice: keyword-only (`vector: null`, all a node-only
hook can run) and hybrid (the prompt embedded with the local model, which a hook cannot load
without the daemon's packages).

**Replay 3, first prompts only.** The hybrid search of replay 2 over only the first typed
prompt of each session.

For replays 2 and 3 one reader (the agent that ran them) judged each prompt's top 3 as relevant
or not. No labelled set exists, so those counts are a reading, not a measurement.

## Findings

1. **A UserPromptSubmit hook's `additionalContext` reaches the model under `claude -p`.** The
   run answered `ZEBRA-7731` in 1 turn (`is_error: false`). The control without the hook
   answered `unknown`.
2. **The payload carries the prompt text.** Its keys: `cwd`, `hook_event_name`,
   `permission_mode`, `prompt`, `prompt_id`, `session_id`, `transcript_path`.
3. **Not probed:** an interactive session, a slash command, a message sent while a turn runs,
   and Codex.
4. **The prompts are short.** Median 25 characters. 56 of the 140 hold 0 or 1 content terms
   ("agreed", "1", "done"), 20 hold 2 or 3, and 64 hold 4 or more.
5. **The strict gate never fires.** 0 of 140 prompts name an indexed file and 0 name a symbol.
   2 hold a word shaped like a filename and none holds a camelCase word.
6. **Keyword search over the prompt is mostly off-topic.** Of the 64 searched prompts 30
   returned results, and about 5 of those 30 had a relevant top 3. "it didn't output anything,
   I'm assuming that's fine?" returned an observation about a test shim.
7. **Hybrid search is better and still mostly off-topic.** 38 prompts returned results, and
   about 12 of them had a relevant top 3.
8. **First prompts do no better than a coin.** Of 52 first prompts 28 were long enough to
   search, 24 returned results, and about 11 of those were relevant.
9. **No score separates the relevant results.** A cosine floor does not improve search on this
   store and drops relevant rows at 0.3 (observation #230).

## Decision

- **No per-prompt push ships**, in any of the three forms. The strict gate would be silent on
  every prompt measured, and each ungated form would put unrelated observations in front of
  the agent on most prompts that trigger it.
- **The item ADR 0014 re-opened is closed.**
- **What shipped instead** answers the same goal through triggers a path or a name verifies:
  - `src/hooks/session-start.ts` deletes the main agent's seen marks when a Claude session
    compacts, so post-read shows a file's history, its "Used by" section and a symbol's
    callers line again after compaction dropped them (12 compactions in the same 8 days).
  - `src/hooks/post-read.ts` treats a Bash `git log`, `git show` or `git blame` that names a
    file as a read of that file (`src/hooks/lib/shell-reads.ts` → `shellHistoryPaths`). Agents
    ran 166 such commands in the 8 days, and 164 named a file with stored observations.
  - `src/hooks/lib/injection.ts` → `SUBAGENT_BULLET` asks the session's agent to name the
    fitting `crank-mem` commands in a subagent's prompt. It reverses the 2026-11-11 choice of
    no parent-briefing instruction, on the maintainer's decision.

## Consequences

- Nothing reaches the agent at the moment the user states a task. The `## Recent memory`
  section at session start stays the only push that is not tied to a file or a symbol.
- A git history command writes the same `file-history` usage line as a `cat`, with
  `tool: "Bash"`, so the usage log cannot tell the two apart.
- A commit listing with no file (657 in the 8 days) and a `git log --grep` (35) show nothing.
- A subagent that compacts keeps its seen marks, and so does a resumed session: whether a
  resume restores earlier hook text was not probed.
- **The subagent line is on trial.** The usage log cannot tell a subagent's command from its
  parent's (ADR 0012), so the reading comes from transcripts: of the Agent-tool prompts in
  main sessions of projects other than this one that ask for code exploration or past work,
  the share that name a `crank-mem` agent command. The baseline is 0 of 59 for 2026-11-10 to
  2026-11-18. After 50 such prompts the line stays if at least 5 name a command, and is
  removed otherwise. The reading goes in this ADR under a dated `## Live reading` section.
- The idea re-opens on new evidence only: a labelled set of prompts with the observations
  each should surface, or a gate that a replay shows firing on real prompts with relevant
  results.

## Re-probe method

1. Build the scratch project and hook as the Method lists them, run the command, and read
   `result` in the JSON output and the hook's stdin log. Run it again with
   `.claude/settings.local.json` moved away; the answer must be `unknown`.
2. For the replays, read the typed prompts from the project's transcripts under
   `~/.claude/projects/` with the Method's filter, then apply the gate against `code.db` and
   run `src/hooks/lib/memory.ts` → `readStore(root, (m) => m.search(...))` per prompt, keeping
   only rows whose `createdAtMs` is before the prompt's timestamp.
3. Judge relevance against a labelled set when one exists; a single reader's count is the
   weakest part of this ADR.
