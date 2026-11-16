# 0017 — The code graph replaces the anatomy (navigation eval)

Date: 2026-11-16. Status: accepted.

## Context

Agents in a crank-mem project learned the code's structure from `.crank/anatomy.md` (a file list
capped at `max_files`, 500, with regex symbols for six languages), from `crank-mem outline` and
`unfold` (one file at a time), and from search's graph list (regex import edges only). None of
them answered "what calls this?", "what does this call?" or "what does changing this reach?", so
agents grepped and read whole files. The cap also hid files: in a 1,210-file repo it cut 59% of
the indexable ones, and an agent could not tell an unindexed file from a missing one.

`.crank/code-graph-memory/spec.md` had put four things out of scope. This ADR records why the
code-graph-navigation work (`.crank/code-graph-navigation/spec.md` and `plan.md`) reverses them,
and the eval that measures whether agents navigate better with the new tool.

## Decision

- **The code graph replaces the anatomy.** A per-project SQLite store, `.crank/code.db`, covers
  every indexable file. Hooks write file facts (size, mtime, tokens, description, activity) in
  plain node; the CLI and daemon write tree-sitter code facts (symbols, imports, call sites).
  `crank-mem callers`, `callees`, `impact` and `anatomy` read it, and so do the session-start
  pointer, Claude's post-read "Used by" section, search's graph list, citation checks,
  consolidation and `stats`. Calls are stored by name and resolved at query time, so editing one
  file never leaves its callers' edges stale. The pointer stays a pointer: the anatomy is never
  inlined, so ADR 0005 stands.
- **The anatomy retires.** `anatomy.md`, `anatomy-index.json`, the regex extractor `symbols.ts` and
  the anatomy lock are gone (commit 9902944); `anatomy` is now a command that renders the graph on
  demand, and `upgrade` removes the retired files from installed projects.
- **Four cuts of the earlier spec reverse:**
  1. **Tree-sitter extraction and a separate `code.db`.** The earlier spec said to revisit "only
     if regex extraction proves too lossy on the eval". Regex symbols carry no call sites at all,
     and the `max_files` cap drops files. `web-tree-sitter` and `@vscode/tree-sitter-wasm` were
     already pinned for `outline` and `unfold`, so the reversal adds no dependency.
  2. **Call edges.** The earlier spec stopped at imports because name-matched call resolution is
     where other code-graph tools spend most of their effort and still miss. Resolution here
     happens at query time over stored call names and never guesses between two candidates: a site
     with no single definition is listed as unresolved, and a symbol name that names several
     definitions is refused with pasteable `Close:` candidates.
  3. **Walks deeper than one hop.** The earlier spec cut "two-hop expansion" on research that found
     two hops below baseline. `impact` walks call edges to `--depth` 1-3 on request. Search's graph
     list stays at one hop and passed its gate (Results, Recall-eval) before it was wired.
  4. **Labelled eval sets.** The earlier spec's eval was digest-request replay, which "at 18
     queries can show a regression but not a small gain". The graph set (35 questions) and the
     symbol set (35 questions) join the 264-question recall set; each question names the one
     observation that answers it. The sets stay git-ignored under `.crank/eval/`.

## Versions

- Claude Code 2.1.325, model `claude-opus-5-5`, claude.ai login.
- bun 1.4.4, macOS (Darwin 27.0.0).
- crank-mem 0.15.0 in both arms.
- Base tree: 340aca0 (`feat(index): resolve TS/JS path aliases and named imports through
  re-exports`), the last commit before the code-graph work. New-arm tool: `git archive HEAD` at
  8a373f0 (`feat(search): seed on symbols and walk call edges in the graph list`), registration and
  run alike.

## Method

**Pre-registration.** The ten tasks, their expected answers and both metrics below were written
before any `claude` run. Each expected set was found by hand with `rg` over the 340aca0 tree and by
reading the enclosing functions, not with `callers`, `callees`, `impact` or `anatomy`; a second
`rg -l` pass re-derived each file-level set and matched it. A set is exact: an agent that names
every item, with extras or not, is correct.

**Arms.** Both arms answer the same questions over the same files.

- **Project.** One `git archive 340aca0` export, copied fresh per arm, then `git init`, `git add -A`
  and one commit, so the project is a git checkout as a real one is. The expected sets were computed
  on this tree.
- **Old arm.** The tool is the 340aca0 export itself: `cd <project> && bun <340aca0 export>/src/cli/main.ts init --yes`
  under a fresh temp `CRANK_HOME`, with `<340aca0 export>/bin` first on `PATH`. The agent sees the
  anatomy pointer and `.crank/anatomy.md`.
- **New arm.** The tool is a `git archive HEAD` export, run the same way. `anatomy` runs once after
  `init`, so the graph holds no pending parse when the first task starts. The agent sees the
  code-graph pointer, the four commands and "Used by" on reads.
- Each tool export gets this clone's `node_modules` as a symlink, as `.crank/code-graph-navigation/eval/reading.sh`
  does for its exports. The project has none.

**Command.** Once per task, from the project directory, with that arm's `CRANK_HOME` and `PATH`:

```
claude -p "<task>" --output-format json --model claude-opus-5-5 --allowedTools "Read,Grep,Glob,Bash(rg *),Bash(crank-mem *)"
```

The project's own `.claude/settings.local.json` (written by `init`) loads the arm's hooks, so each
run starts with that arm's session-start injection. The harness is `nav-eval/run.sh <arm>`,
which writes `nav-eval/<arm>.jsonl` (one line per task: the task id and claude's raw result
object); `nav-eval/score.ts <arm>` scores it. Both live beside `tasks.jsonl` under
`.crank/code-graph-navigation/nav-eval/` and are git-ignored.

**Metrics.**

- **Correct.** The result's `result` text contains every expected item as a substring, and
  `is_error` is not true. Per arm: the number of correct tasks out of 10.
- **Cost.** `num_turns` and total tokens from the one result object `--output-format json` prints.
  Total tokens is `usage.input_tokens + output_tokens + cache_creation_input_tokens + cache_read_input_tokens`
  (the sum over `modelUsage` when `usage` is absent). Per arm: the median of each over the 10 tasks.

**Limits.** One run per task per arm, so a model's run-to-run variance is not measured; ten tasks
can show a large gap, not a small one. Every question asks for files or functions, so the eval
measures structural navigation and nothing about recall of past work. Both arms may read the
tree's own `CLAUDE.md`, which names `crank-mem`. A compound Bash call that contains a `crank-mem`
command can be denied by the `Bash(crank-mem *)` allow rule (ADR 0014), and the eval counts those
turns against the arm that made them.

**Tasks.** Every question ends with a scope line: "Scope: the src/ and scripts/ trees only; ignore
tests/, dashboard/ and docs/." followed by the answer format ("Answer with the complete list ...
and nothing else.").

**t01** (callers, 3 expected). Which files call the function `readStoreSync`, defined in src/hooks/lib/memory.ts? Leave out the defining file and count calls only, not import lines. Scope: the src/ and scripts/ trees only; ignore tests/, dashboard/ and docs/. Answer with the complete list of repo-relative file paths, one per line, and nothing else.

Expected: `src/hooks/lib/citations.ts`, `src/hooks/lib/injection.ts`, `src/cli/stats.ts`.

**t02** (callers, 5 expected). Which files call the function `recordUsage`, defined in src/hooks/lib/usage.ts? Leave out the defining file and count calls only, not import lines. Scope: the src/ and scripts/ trees only; ignore tests/, dashboard/ and docs/. Answer with the complete list of repo-relative file paths, one per line, and nothing else.

Expected: `src/hooks/session-start.ts`, `src/hooks/post-read.ts`, `src/hooks/subagent-start.ts`, `src/cli/recall.ts`, `src/cli/code.ts`.

**t03** (callers, 8 expected). Which files call the function `projectName`, defined in src/hooks/lib/owner.ts? Leave out the defining file; count calls only, not import lines or mentions in comments. Scope: the src/ and scripts/ trees only; ignore tests/, dashboard/ and docs/. Answer with the complete list of repo-relative file paths, one per line, and nothing else.

Expected: `src/hooks/post-read.ts`, `src/daemon/digest-route.ts`, `src/daemon/digest-job.ts`, `src/cli/recall.ts`, `src/cli/dashboard-server.ts`, `src/hooks/lib/registry.ts`, `src/cli/updates.ts`, `src/cli/upgrade.ts`.

**t04** (callers, 3 expected). Which files call the function `relatedFiles`, defined in src/hooks/lib/related-files.ts? Leave out the defining file and count calls only, not import lines. Scope: the src/ and scripts/ trees only; ignore tests/, dashboard/ and docs/. Answer with the complete list of repo-relative file paths, one per line, and nothing else.

Expected: `scripts/recall-eval.ts`, `src/cli/recall.ts`, `src/cli/dashboard-server.ts`.

**t05** (impact, 5 expected). What breaks if the signature of `citationCheck`, defined in src/hooks/lib/citations.ts, changes? Name every function whose body calls `citationCheck` directly. Scope: the src/ and scripts/ trees only; ignore tests/, dashboard/ and docs/. Answer with the complete list, one per line, each as `<function name> (<repo-relative file path>)`, and nothing else.

Expected: `excerptBlock`, `composeInjection`, `subagentInjection`, `memoryLines`, `consolidate`.

**t06** (impact, 2 expected). What breaks, up to two hops away, if the return type of `storeVersion`, defined in src/hooks/lib/memory.ts, changes? Name every function that calls `storeVersion` directly, and every function that calls one of those functions. Scope: the src/ and scripts/ trees only; ignore tests/, dashboard/ and docs/. Answer with the complete list, one per line, each as `<function name> (<repo-relative file path>)`, and nothing else.

Expected: `schemaBlockers`, `refuseOlder`.

**t07** (impact, 5 expected). What breaks if the signature of `commitIndex`, defined in src/hooks/lib/store.ts, changes? Which files call it? Leave out the defining file and count calls only, not import lines or mentions in comments. Scope: the src/ and scripts/ trees only; ignore tests/, dashboard/ and docs/. Answer with the complete list of repo-relative file paths, one per line, and nothing else.

Expected: `src/hooks/session-start.ts`, `src/hooks/post-write.ts`, `src/cli/scan.ts`, `src/cli/upgrade.ts`, `src/cli/init.ts`.

**t08** (imports, 14 expected). Which files import src/hooks/lib/owner.ts, by any import form (static, type-only or dynamic)? Scope: the src/ and scripts/ trees only; ignore tests/, dashboard/ and docs/. Answer with the complete list of repo-relative file paths, one per line, and nothing else.

Expected: `src/hooks/post-read.ts`, `src/hooks/post-write.ts`, `src/hooks/lib/scanner.ts`, `src/daemon/digest-route.ts`, `src/daemon/digest-job.ts`, `src/hooks/lib/memory.ts`, `src/hooks/lib/registry.ts`, `src/hooks/lib/untouched.ts`, `src/cli/recall.ts`, `src/hooks/lib/hook-io.ts`, `src/cli/updates.ts`, `src/cli/upgrade.ts`, `src/cli/dashboard-server.ts`, `src/cli/code.ts`.

**t09** (imports, 11 expected). Which files import src/hooks/lib/lock.ts, by any import form (static, type-only or dynamic)? Scope: the src/ and scripts/ trees only; ignore tests/, dashboard/ and docs/. Answer with the complete list of repo-relative file paths, one per line, and nothing else.

Expected: `src/hooks/session-start.ts`, `src/hooks/post-write.ts`, `src/hooks/lib/store.ts`, `src/daemon/daemon.ts`, `src/hooks/lib/untouched.ts`, `src/cli/tool-install.ts`, `src/hooks/lib/usage.ts`, `src/cli/upgrade.ts`, `src/cli/init.ts`, `src/cli/scan.ts`, `src/cli/uninstall.ts`.

**t10** (imports, 18 expected). Which files import src/hooks/lib/store.ts, by any import form (static, type-only or dynamic)? Scope: the src/ and scripts/ trees only; ignore tests/, dashboard/ and docs/. Answer with the complete list of repo-relative file paths, one per line, and nothing else.

Expected: `scripts/recall-eval.ts`, `src/hooks/session-start.ts`, `src/hooks/post-write.ts`, `src/hooks/post-read.ts`, `src/hooks/lib/citations.ts`, `src/daemon/consolidate.ts`, `src/hooks/lib/injection.ts`, `src/hooks/lib/scanner.ts`, `src/cli/stats.ts`, `src/cli/recall.ts`, `src/hooks/lib/activity.ts`, `src/cli/scan.ts`, `src/cli/dashboard-server.ts`, `src/hooks/lib/related-files.ts`, `src/cli/upgrade.ts`, `src/cli/init.ts`, `src/cli/uninstall.ts`, `src/hooks/lib/imports.ts`.

## Results

### Recall-eval readings

Replays of `bun scripts/recall-eval.ts` against the frozen eval store
(`.crank/code-graph-navigation/eval/frozen-memory.db`), each from a `git archive` export of the
named commit, from `eval/reading.sh`. Cells are mean reciprocal rank, `base list / graph list`
(`mode hybrid` on every row). The digest set replays 63 digest requests; the recall set is 264
questions, the graph set 35 and the symbol set 35.

| reading | commit | digest | recall | graph | symbol |
| --- | --- | --- | --- | --- | --- |
| `base.txt` | 340aca0 | 0.58 / 0.59 | 0.91 / 0.91 | 0.64 / 0.66 | not written yet |
| `port.txt` | 4cbd9d6 | 0.58 / 0.59 | 0.91 / 0.91 | 0.64 / 0.66 | not read |
| `symbol-check.txt` | 60a7cf1 | 0.58 / 0.59 | 0.91 / 0.91 | 0.64 / 0.66 | 0.92 / 0.78 |
| `search.txt` | 8a373f0 | 0.58 / 0.59 | 0.91 / 0.91 | 0.64 / 0.66 | 0.92 / 0.98 |

- `port.txt` equals `base.txt` on every mean: moving the readers from the anatomy to `code.db`
  changed no recall number. Its seeded-query counts moved from 13 to 15 of 264 (recall set) and
  stayed 35 of 35 (graph set).
- `symbol-check.txt` is an intermediate reading, not one of the three the plan names. It shows the
  import-only graph list lowering symbol-set mrr from 0.92 to 0.78, which is why `search.txt`
  had to clear 0.94 on that set.
- `search.txt` passes the gate (criterion 30): the graph list is at or above the base list on the
  digest, recall and graph sets (mrr 0.59 / 0.91 / 0.66, equal to `port.txt`), and rises on the
  symbol set, 0.92 to 0.98 (recall@5 0.97 to 1.00; recall@10 1.00 on both). Symbol seeds take
  call-edge neighbours only; the graph set seeds 34 of 35 queries, one fewer than `port.txt`, with
  mrr unchanged.

### Navigation eval

Run on 2026-11-16 by the user, once per task per arm, with `claude-opus-5-5`. Both arms
answered every task correctly.

| arm | correct (of 10) | median turns | median tokens |
| --- | --- | --- | --- |
| old (340aca0 tool, anatomy) | 10 | 3 | 125,470 |
| new (HEAD tool, code graph) | 10 | 3 | 126,276 |

| task | old turns / tokens | new turns / tokens |
| --- | --- | --- |
| t01 | 3 / 82,925 | 2 / 82,549 |
| t02 | 2 / 82,944 | 4 / 125,224 |
| t03 | 2 / 83,203 | 2 / 83,158 |
| t04 | 3 / 124,188 | 4 / 124,687 |
| t05 | 4 / 170,266 | 5 / 214,574 |
| t06 | 4 / 170,050 | 4 / 169,228 |
| t07 | 4 / 125,031 | 3 / 82,875 |
| t08 | 3 / 126,801 | 3 / 128,692 |
| t09 | 3 / 125,908 | 3 / 127,328 |
| t10 | 3 / 126,201 | 3 / 127,847 |

- **The new arm never used the graph commands.** The new project's `usage.jsonl` holds 10
  `session-start` lines and one `anatomy` line, the harness's own pre-parse call; no `callers`,
  `callees` or `impact` line. The old project's holds 10 `session-start` lines. Both arms answered
  with `rg`, so the eval compares `rg` with `rg`, and the per-task differences are run-to-run
  noise of one run each (t02 and t05 cost the new arm one extra turn; t07 saved it one).
- **What this does and does not show.** The pointer reached every run (one `session-start` line
  per task) and `Bash(crank-mem *)` was allowed, yet the agent preferred `rg` on tasks that `rg`
  answers in two to four turns. The eval therefore measures no navigation gain and no loss; it
  does not measure the commands themselves.
- A follow-up eval that tells the arms apart needs tasks where a name search is ambiguous (same
  names in several files, or member calls whose receiver type decides the target), or a pointer
  that leads the agent to the commands. Neither is in this decision.

## Consequences

- Installed projects hold `.crank/code.db` instead of the anatomy files; `upgrade` migrates them.
- The session-start injection points at `crank-mem anatomy`, `callers`, `callees` and `impact`
  where it pointed at `.crank/anatomy.md`, and the Bash allow rules carry the four commands.
- The navigation eval does not gate the commands (the spec's choice). A result where the new arm
  is no better is a finding about the pointer text or the commands, and the recall gate above
  stands on its own.
