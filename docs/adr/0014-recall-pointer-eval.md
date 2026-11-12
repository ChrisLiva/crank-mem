# 0014 — The recall pointer eval: old and new pointer under `claude -p` (probe-verified)

Date: 2026-11-12. Status: accepted.

## Context

Agents logged no `crank-mem search`, `timeline` or `get` call in 1.5 days of usage lines, though
every session start and subagent start carried the recall pointer (observation #118 in this
project's store). Two commits on the `recall-adoption` branch change what the agent sees:

- 5c95b19 (`feat(injection): say when to recall and how to open a shown id`) rewrites
  `src/hooks/lib/injection.ts` → `RECALL_BULLET`. The old bullet named the three commands. The
  new one names the moments to recall (before changing how an area behaves, when debugging a
  failure again, when the user mentions earlier work) and says `crank-mem get <id...>` opens
  any `#id` the injection or file history shows.
- 0c4b410 (`feat(recall): name crank-mem get in surfaced-list headings`) adds
  `` (open one: `crank-mem get <id>`) `` to the `## Recent memory` heading and to the
  `History of <file>` header that `src/hooks/post-read.ts` → `histories` prints.

Whether that text makes an agent recall more, and whether recall makes its answers better,
only live runs can tell. This ADR records a two-arm `claude -p` eval of the old text (arm A)
against the new text (arm B) on one shared fixture, and the ship decision that rests on it.
It also records a reading the usage lines need: whether a `crank-mem` call made from the
`claude -p` Bash tool records `agent: "claude"` and a session id
(`src/hooks/lib/usage.ts` → `cliActor`).

## Versions

- Claude Code 2.1.322, model alias `sonnet`, claude.ai login (`claude auth status`:
  `loggedIn: true`, `apiProvider: firstParty`).
- bun 1.4.4, macOS (Darwin 27.0.0).
- crank-mem 0.13.0 in both arms.
- Arm A: tree at 7885ea2d2724dc89696c8c1ba3da4d727dce7170 (v0.13.0, the old pointer and
  headings).
- Arm B: tree at 0c4b410994cb961549900737915642656c29d92c (both commits above).

The eval scripts, fixture and run logs lived in a scratch directory outside the repo and are
not part of it.

## Method

**Arm setup.** Each arm is a frozen tree, `git archive <sha> | tar -x`, with this clone's
`node_modules` linked in (`package.json` and `bun.lock` are unchanged between the two SHAs).
Each arm has its own `bin/crank-mem`, a symlink to its tree's `bin/crank-mem`, and its own
empty `CRANK_HOME`. Both arms copy one fixture project: a small TypeScript shop backend with
8 files under `src/` (`index.ts`, `webhooks.ts`, `net/retry.ts`, `net/client.ts`,
`billing/tax.ts`, `billing/invoice.ts`, `cache/lru.ts`, `config/flags.ts`) and a
`package.json`. No project file mentions memory, crank-mem, notes or past sessions. In each
arm's copy: `git init -q && git add -A && git commit -qm fixture`, then
`CRANK_HOME=<arm home> bun <arm tree>/src/cli/main.ts init --yes`, which writes the hooks into
`.claude/settings.local.json` and vendors that tree's `src/hooks/` into `.crank/hooks/`.
Digests stay off (the default), so no Stop hook spools a run. A scratch script then opens
`memoryPath(project)` with that tree's `openMemory(…, "write")` and calls `appendDigest` once
with 46 observations (session `eval-seed`, model `seed`, cost 0, no proposals, no stale
flags), in this order:

1. ids 1–3: the three search-task decisive observations (S1, S2, S3), `filesRead: []`.
2. ids 4–43: 40 filler observations about other parts of the project (logger, date formatter,
   CLI argument parser, README layout, lint setup, test runner config, error classes,
   environment loader, build output folder, type exports), `filesRead: []`.
3. ids 44–46: the three follow-through decisive observations (F1, F2, F3), each with one
   `filesRead` entry, the file its prompt names.

Each decisive narrative carries one made-up answer token that appears in no project file, no
prompt, no title and no other observation. The S observations are the oldest, so the 1536-byte
`## Recent memory` section does not show them and no file cites them: only `crank-mem search`
finds them. The F titles are the newest three, so `## Recent memory` lists them by id and
title, and a Read of the cited file adds a `History of <file>` section that lists them too;
the token is only in the narrative, so only `crank-mem get` (or a search) shows it. Both arm
CRANK_HOMEs hold no embedding model, so `search` runs keyword-only in both arms; a check
before the runs found each S decisive id at rank 1 for a two-word query in both arms. The
usage lines those checks wrote were deleted before any copy.

**Command and env.** Each run has a fresh copy, `cp -Rp <arm>/project runs/<arm>-<task>-<n>`,
and runs from that copy as:

```
env -i HOME="$HOME" USER="$USER" TMPDIR="$TMPDIR" PATH="$S/<arm>/bin:$PATH" CRANK_HOME="$S/<arm>/home" claude -p --model sonnet --setting-sources project,local --output-format stream-json --verbose --settings '{"permissions":{"allow":["Bash(crank-mem search *)","Bash(crank-mem timeline *)","Bash(crank-mem get *)","Bash(crank-mem outline *)","Bash(crank-mem unfold *)"]}}' "<prompt>"
```

stdout goes to `runs/<arm>-<task>-<n>.jsonl`. A run is killed at 300,000 ms
(`src/daemon/gateway.ts` → `RUN_TIMEOUT_MS`), and the runner leaves an empty
`runs/<arm>-<task>-<n>.timeout` beside it. At most 3 runs go at once. Counted runs: 6 tasks ×
2 arms × 3 runs = 36. Before them, one uncounted pre-flight run per arm uses the prompt
"Run crank-mem search webhook signing and tell me the first line it prints." and must show a
`session-start` usage line with `recallPointer: true` and non-empty `ids`, a `search` usage
line, and no `crank-mem` command in `permission_denials`.

**Tasks.** Prompts, verbatim:

| Task | Type | Prompt |
|---|---|---|
| S1 | search | Webhook signing secrets in this project rotate every 30 days. Which vendor contract reference requires that rotation schedule? Give the reference code. |
| S2 | search | Who in finance approved the invoice numbering prefix this project uses? Give the approver's name. |
| S3 | search | What is the on-call runbook page for flipping the checkout redesign kill switch? Give its runbook page id. |
| F1 | follow-through | In src/net/retry.ts, MAX_ATTEMPTS is 4. Which incident ticket led to that cap? Give the ticket id. |
| F2 | follow-through | src/billing/tax.ts rounds tax with half-even rounding. Who asked for that rounding mode? Give the person's name. |
| F3 | follow-through | src/cache/lru.ts sets DEFAULT_CAPACITY to 512 entries. Which load test run was that number taken from? Give its run id. |

**Decisive observations**, verbatim:

| Task | Id | Type | Title | Narrative |
|---|---|---|---|---|
| S1 | 1 | decision | Webhook signing secret rotation schedule set by vendor contract | Webhook signing secrets rotate every 30 days because the payment vendor contract requires it; the vendor contract reference for that rotation schedule is VND-4471. |
| S2 | 2 | decision | Invoice numbering prefix approved by finance | The invoice numbering prefix SF- was agreed with finance; the finance approver who signed off on the invoice numbering prefix was Dorrit Valkenhorst. |
| S3 | 3 | discovery | Checkout redesign flag has an on-call kill switch | The checkout redesign feature flag doubles as a kill switch; the on-call runbook page for flipping the checkout redesign kill switch is RB-2290. |
| F1 | 44 | decision | Retry cap in src/net/retry.ts set to four attempts after a gateway outage | MAX_ATTEMPTS in src/net/retry.ts was capped at four after incident INC-7319, where unbounded retries against the payments gateway tripled its load during an outage. |
| F2 | 45 | change | Tax rounding in src/billing/tax.ts switched to half-even at an auditor's request | Rounding in src/billing/tax.ts moved from half-up to half-even because the external auditor Marla Quenby flagged half-up drift across invoice totals. |
| F3 | 46 | discovery | LRU capacity in src/cache/lru.ts sized from a load test | DEFAULT_CAPACITY of 512 in src/cache/lru.ts was sized from load test run LT-0884, which showed the hit rate flattening above that size. |

**Answer regexes**, case-insensitive: S1 `VND-?4471`, S2 `Valkenhorst`, S3 `RB-?2290`,
F1 `INC-?7319`, F2 `Quenby`, F3 `LT-?0884`.

**Tally rules.**

- A run *recalled* when any Bash `tool_use` block in its stream-json has an input `command`
  matching `crank-mem (search|timeline|get)`.
- A run is *correct* when its final `result` event's `result` text matches its task's regex.
- A timed-out run counts as not recalled unless its partial stream shows a recall call, and
  as not correct. A run file with no `result` event and no `.timeout` marker fails the tally.
- Per arm: recall share = recalled runs / 18, and correct count of 18. Per task and arm:
  recalled of 3 and correct of 3.
- Environment reading: from the `search`, `timeline` and `get` lines in every run copy's
  `.crank/usage.jsonl` (counted and pre-flight), count lines with `agent: "claude"` and lines
  with a non-null `session`.

**Win rule (pre-registered).** Arm B's share of runs with any recall is at least 25 percentage
points above arm A's, and arm B's correct-answer count is at least arm A's.

**Ship gate.** If arm B's correct count is at least arm A's, both commits merge. If it is
lower, both are reverted, and the figures and this ADR still merge. If the win rule fails,
the deferred per-prompt push (a UserPromptSubmit hook) is re-opened.
## Findings

1. **Both arms recalled in every run and answered every run correctly.** All 36 counted runs
   ended `success` with a `result` event; none timed out. Every run used
   `claude-sonnet-5-5` and averaged 2.6 turns. Arm A: 18 of 18 runs recalled (100%), 18 of 18
   correct, $0.99 in total, mean 5.4 s. Arm B: 18 of 18 runs recalled (100%), 18 of 18
   correct, $0.97 in total, mean 7.1 s.

   | Task | Type | Arm | Recalled of 3 | Correct of 3 |
   |---|---|---|---|---|
   | S1 | search | A | 3 | 3 |
   | S1 | search | B | 3 | 3 |
   | S2 | search | A | 3 | 3 |
   | S2 | search | B | 3 | 3 |
   | S3 | search | A | 3 | 3 |
   | S3 | search | B | 3 | 3 |
   | F1 | follow-through | A | 3 | 3 |
   | F1 | follow-through | B | 3 | 3 |
   | F2 | follow-through | A | 3 | 3 |
   | F2 | follow-through | B | 3 | 3 |
   | F3 | follow-through | A | 3 | 3 |
   | F3 | follow-through | B | 3 | 3 |

2. **The two arms took the same path.** In every S run, both arms ran `crank-mem search` with
   words from the prompt and then `crank-mem get` on the decisive id (1, 2 or 3). In every F
   run, both arms' first recall call was `crank-mem get` on the id that `## Recent memory`
   listed beside the cited file's title (44, 45 or 46), and none ran `search`. Neither arm
   needed the new trigger wording or the `crank-mem get` heading hint to do this: an id next to
   a matching title was enough under the old text. Arm B's F runs ran fewer extra greps after
   the `get` (4 of 9 F runs in arm B ran only `crank-mem get`, against 0 of 9 in arm A).
3. **One compound command was denied.** In arm A's S1 run 1, a Bash call that chained
   `crank-mem get 1; grep …; ls .crank; grep …` showed up in `permission_denials`: a
   `Bash(crank-mem get *)` allow rule does not cover a compound command. The run had already
   run `crank-mem get 1` alone and answered correctly. No other run had a denial, and neither
   pre-flight run did.
4. **The environment reading: a `crank-mem` call from the `claude -p` Bash tool records the
   agent and the session.** Across the 38 run copies (36 counted, 2 pre-flight), the usage
   files hold 57 recall lines (21 `search`, 36 `get`, 0 `timeline`). All 57 record
   `agent: "claude"`, and all 57 have a non-null `session`. So `CLAUDECODE` and
   `CLAUDE_CODE_SESSION_ID` are both set in that Bash tool's environment, even under
   `env -i`, and `src/hooks/lib/usage.ts` → `cliActor` ties those calls to their session.
   Each pre-flight copy also held a `session-start` line with `recallPointer: true` and 22
   (arm A) or 21 (arm B) recent ids, none of them 1, 2 or 3.

## Decision

- **The win rule fails.** Arm B's recall share (100%) is 0 percentage points above arm A's
  (100%), short of the 25 points the rule needs. Its second condition holds: arm B's correct
  count (18) is at least arm A's (18).
- **The pointer and `get`-pointer changes merge.** The ship gate rests on the correct counts
  alone, and arm B's 18 is not below arm A's 18, so 5c95b19 and 0c4b410 stay and no revert is
  made.
- **The deferred per-prompt push (a UserPromptSubmit hook) is re-opened**, because the win
  rule failed.

## Consequences

- This eval cannot tell the two pointers apart: both arms hit the ceiling. Each prompt asks
  for a fact the code does not hold, under a bare `claude -p` with nothing else to do, so
  Sonnet reached for `crank-mem` in both arms. The live usage lines that started this work
  (no recall in 1.5 days) come from sessions where the agent is doing a real task and the
  stored fact is helpful rather than the only way to answer. A fixture that measures adoption
  needs tasks that can be finished without recall but are done better with it.
- An id beside a title in `## Recent memory` is enough for Sonnet to run `crank-mem get` under
  either text, so the follow-through path works whenever the right title is in the recent
  list. The search path works when the question cannot be answered from the code.
- `cliActor` records `agent: "claude"` and the session id for a `claude -p` Bash call, so
  usage metrics can tie recall calls to the session that made them, and a `manual` line means
  a call made outside Claude Code.
- An agent that chains `crank-mem get` with other commands in one Bash call falls outside the
  `Bash(crank-mem get *)` allow rule and, under `-p`, is denied.

## Re-probe method

1. Build the two arm trees: `git archive <sha> | tar -x -C <arm>/tree` for each arm's SHA,
   link this clone's `node_modules` into each, and link `<arm>/bin/crank-mem` to
   `<arm>/tree/bin/crank-mem`. Check that `package.json` and `bun.lock` match between the SHAs.
2. Write the fixture project and the 46 observations as the Method lists them. Copy the
   project into each arm, `git init` and commit it, run
   `CRANK_HOME=<arm>/home bun <arm>/tree/src/cli/main.ts init --yes` from it, and seed it with
   one `appendDigest` call through that tree's `openMemory(memoryPath(project), "write")`.
   Delete `.crank/usage.jsonl` after any check search.
3. Run one pre-flight per arm, then the 36 counted runs with the Method's exact command, a
   300,000 ms kill timeout and at most 3 at once, each from a fresh `cp -Rp` copy.
4. Tally with the Method's rules from the stream-json files and each copy's
   `.crank/usage.jsonl`.
5. To re-run on Opus, change `--model sonnet` to `--model opus` and record the model the
   stream's `init` event names. To get a reading that can separate the arms, swap in tasks
   that can be finished without recall.
