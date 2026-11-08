# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

- `bun test` — run all tests
- `bun test tests/scanner.test.ts` — run one test file
- `bun test -t "pattern"` — run tests matching a name
- `bun run typecheck` — `tsc --noEmit`, then `tsc --noEmit -p dashboard`
- `cd dashboard && bun run build` — rebuild the dashboard page; vite empties `dashboard/dist/` first and drops its `.crank-version` stamp, so `crank-mem dashboard` refuses as not built until `crank-mem setup` (or any `crank-mem upgrade`) restamps it
- `bun run format` / `bun run format:check` — oxfmt (pinned exact in `package.json`). `.oxfmtrc.json` leaves out `tests/fixtures/`, whose bytes the `.outline`/`.headers` goldens record, and all markdown, whose ADRs quote probe output verbatim and whose README shows JSONL one record per line

`bun test` needs `crank-mem setup` (or `bun src/cli/main.ts setup`) run once on the machine: `tests/digest-job.test.ts`, `tests/embedder.test.ts`, `tests/setup.test.ts` and `tests/cli-commands.test.ts` read the real model it downloads into `~/.crank/models`.

There is no build step except the dashboard, which `crank-mem setup` builds into `dashboard/dist/` (`upgrade` rebuilds it when the stamp is not the clone's version). `bin/crank-mem` is a shell launcher that runs `src/cli/main.ts` directly under bun (or node >= 23.6, which also executes TypeScript natively). Hooks under `src/hooks/` import only `node:` modules, and `tests/hooks-imports.test.ts` enforces it; `src/daemon/` and `src/cli/code-symbols.ts` may carry packages, loaded by dynamic `import()` so every other command works without them. `package.json` pins three packages exact: `@huggingface/transformers` for the embedder, and `web-tree-sitter` and `@vscode/tree-sitter-wasm` for `outline` and `unfold`.

## What this is

Project memory for coding agents (Claude Code + Codex): a token-annotated file anatomy index plus a `cerebrum.md`, injected at session start and silently re-indexed on writes. With `crank-mem digest on`, finished Claude Code sessions, and live ones every 2 hours, are digested automatically into `.crank/memory.db` (SQLite with FTS5 plus local embeddings); after a digest, consolidation checks the digests' proposals and stale flags against the code and keeps `cerebrum.md`, which agents no longer write. Agents recall the store through `crank-mem search`, `timeline` and `get`, session-start sections and per-file history. Installed into a target project as `.crank/` (index, anatomy.md, cerebrum.md, memory.db, config.json, vendored hooks, backups, including the daily `backups/memory/` snapshots of memory.db); per-user state (digest spool, daemon heartbeat, stop state, models, the dashboard token in `dashboard.json` and the project registry in `projects.json`) lives under `~/.crank` (`$CRANK_HOME`).

## Architecture

Three entry surfaces share one core:

- **CLI** (`src/cli/`) — `main.ts` dispatches to per-command modules (`init`, `scan`, `digest`, `search`, `timeline`, `get`, `outline`, `unfold`, `restore-memory`, `setup`, `stats`, `dashboard`, `upgrade`, `uninstall`, plus the internal `daemon` and `job`) via dynamic imports. `src/cli/code.ts` holds `outline` and `unfold`, and `src/cli/code-symbols.ts` holds the tree-sitter reader they share. `src/cli/dashboard.ts` is the foreground `dashboard` command (flags, the token file, the port-taken check, signals); `src/cli/dashboard-server.ts` → `serveDashboard` applies every guard and serves the static `dashboard/dist/` build and the `/api` routes over `node:http`, opening each store with `openMemory(file, "read")`; `src/cli/usage-metrics.ts` is the pure aggregator of usage lines behind `/api/projects/<id>/usage`; `src/cli/registry.ts` keeps the per-user project list that `init` and `upgrade` add to and `uninstall` removes from. The page itself is a separate Vite + React package in `dashboard/`. Runs from the clone.
- **Hooks** (`src/hooks/session-start.ts`, `src/hooks/post-write.ts`, `src/hooks/post-read.ts`, `src/hooks/stop.ts`, `src/hooks/session-end.ts`, `src/hooks/subagent-start.ts`) — invoked by the agents with a JSON payload on stdin. `init` vendors a recursive copy of `src/hooks/` (including `lib/`) into `<project>/.crank/hooks/` (`src/cli/vendor.ts`), so hooks run self-contained inside each target project while the CLI imports the same `lib/` from the clone. Consequence: everything under `src/hooks/` must work from either location and import nothing outside `src/hooks/`. `stop.ts` and `post-write.ts` emit nothing model-visible (ADRs 0004 and 0010). Claude subagents never see SessionStart, so `subagent-start.ts` gives the agent types in `SUBAGENT_MATCHER` a 2 KB cerebrum excerpt, the code pointer and the recall pointer (ADR 0007). Stop and `session-end.ts` write the session's digest spool entry; `post-read.ts` adds a file's stored history when Claude reads it with Read or Bash (ADR 0009).
- **Daemon** (`src/daemon/`) — clone-only, never vendored: `daemon.ts` (one per user, sweep loop starting one `crank-mem job` at a time), `digest-job.ts` (one-shot digest of a spool entry into `memory.db`), `gateway.ts` (`claude -p` on the user's own login, the only spawn of `claude` — ADR 0008), `digest-prompt.ts`, `consolidate.ts` (consolidation after a digest: a `claude -p` run with read-only tools over the project reviews proposals, stale flags and bullets whose cited files changed, then edits `cerebrum.md` — ADR 0011), `cerebrum-edit.ts` (pure bullet numbering and edit application), `redact.ts` (always-on secret redaction), `transcript.ts` (transcript reader and distiller) and `embedder.ts` (local embeddings).

The shared core is `src/hooks/lib/`: `scanner.ts` (index refresh with time budget), `store.ts` (anatomy-index.json load/save + anatomy.md render), `injection.ts` (session-start context assembly under a byte budget), `bullets.ts` (markdown bullet grouping shared by the cerebrum excerpt and consolidation — whole bullets, headings as hard boundaries), `cerebrum-files.ts` (memory file names, cerebrum's size limits, the `backups/cerebrum/` copies and audit-backup detection), `drift.ts` (one-line warning when the vendored hooks lag the clone), `symbols.ts` / `tokens.ts` / `describe.ts` (per-file analysis), `config.ts` (.crank/config.json + always-on sensitive-file filter), `lock.ts` (cross-process lock around index writes), `hook-io.ts` (stdin parsing, project-root discovery, `additionalContext` emission, `repoRelative` and `memoryPaths`), `memory.ts` (`memory.db` queries over `node:sqlite`, loaded through `process.getBuiltinModule`, plus the daily maintenance snapshot and stale-row retention, and `restoreMemory`), `spool.ts` (per-user digest spool, daemon start, `digestGate`), `user-state.ts` (`<crank home>`, stop state), `shell-reads.ts` (files a Bash command reads), `apply-patch.ts` (Codex patch-text parsing), `debug.ts` (opt-in per-run JSONL trace to `.crank/debug.log`, off by default), `usage.ts` (`recordUsage`, the always-on usage line contract appended to `usage.jsonl` beside `memory.db` and rotated to `usage.1.jsonl` at 4 MiB).

### Invariants

- **Hooks are advisory-only: every path exits 0.** Never let a hook throw, block, or emit errors that could break an agent session. A corrupt or missing index degrades to `emptyIndex()` and reconverges on the next scan.
- All index writes happen under `withLock`; hooks operate under hard time budgets (refresh budget, lock-wait budget) and report staleness in the injection rather than blocking.
- The sensitive-file filter in `config.ts` is not configurable — never index secrets.
- Model-visible output goes only through `hookSpecificOutput.additionalContext` on stdout; stderr is human/debug-only (see ADR 0001).
- Debug logging is subject to the same advisory-only contract: `debug.ts` never throws, never writes to stdout, and never records a sensitive path.

### ADRs record probe-verified agent behavior

`docs/adr/` documents live-probed facts about Claude Code and Codex (which hook channels reach the model, Codex's trust-hash formula, Codex tool shapes — notably: Codex has no Read tool, and writes arrive as `apply_patch` patch text). Design decisions rest on these probes; don't change behavior they cover without re-probing (method is in each ADR), and record new probe findings as ADRs.

## Testing conventions

Tests are black-box: hooks and CLI commands are executed as real child processes with agent-like stdin payloads via `runHook` and `runCli` in `tests/helpers.ts`, with `fakeClaude` standing in for the `claude` binary and `startDaemon` running the real daemon under a temp `CRANK_HOME` (no test runs the real `claude`), against temp projects built by `makeCrankProject`. Agent payload fixtures live in `tests/fixtures/payloads.ts`. Prefer this style over importing hook internals — assertions should hold against exit status, stdout JSON, and on-disk `.crank/` state.

`bun test` runs the test process in UTC with `TZ` unset, while `runCli` and `runHook` children run in the system zone, so an in-process local-date assertion passes against UTC getters too. Pin local dates through a CLI child with `TZ` in its env, in zones on both sides of UTC (`tests/helpers.ts` → `ZONES`).

The `spawnSync` timeout in `tests/helpers.ts` → `runCli` kills only the CLI child; a grandchild that hangs, such as `fakeClaude` with `auth: "hang"`, keeps running at ppid 1. After a RED run that hit the timeout, find leftover fake `claude` processes with `ps` and kill them.

`tests/daemon.test.ts` → `a hold belongs to one stem, a refusal holds like a failure, and exit 0 clears it` asserts a retry gap under 800 ms, and spawn overhead under machine load pushes the gap past it. At load average about 2.5 it failed 5 of 6 solo runs (2 of 3 at `b7336dc`, 3 of 3 at `1a8eba3`), with gaps of 1,023 to 1,489 ms. A failure showing a gap just over 800 ms predates stage 2 and is not by itself a regression; a solo rerun does not tell the two apart.

At load average about 1.5 the hold test still failed every solo run made at `ea1698d` and after it, with gaps of 844 to 876 ms; it carries its own `25_000` timeout, so its failures are always the gap. When a test with no explicit timeout passes bun's 5,000 ms default, bun kills the children it spawned and `runCli` reports each as status `-1`, so `Expected: 0, Received: -1` on a test near 5 s is a timeout, not a crash. `bun test tests/snapshots.test.ts -t "the pass waits a day" --timeout 3000` reproduces it; that test runs about 4.4 s solo and now passes `20_000`.

The same file's `a failing stem waits --retry-ms, doubling each failure up to --retry-cap-ms` asserts a first gap under 700 ms and is load-sensitive in the same way: it failed at `cd03457` at load average about 5.5, and a full-suite run during the stage-5 final gate measured 778 ms. Neither daemon timing test is a regression signal unless `src/daemon/` changed.

Other `tests/snapshots.test.ts` tests still run on bun's 5,000 ms default, and the `maintenance` and `restore-memory` ones take about 4.75 s solo. At load average about 7, one or two of them reported `Received: -1` even when the file ran alone, at `f1a6e00` and at `50527b9` alike (2 of 15 failed, with the failing test changing from run to run), while `bun test tests/snapshots.test.ts --timeout 20000` passed 15 of 15 at `f1a6e00`. Rerun that file with `--timeout 20000` before reading such a failure as a regression.

To probe an fs failure path (such as `src/hooks/lib/spool.ts` → `settleEntry`'s non-`EEXIST` link fallback), run the probe under node: assigning `fs.linkSync` on the default `node:fs` import and calling `syncBuiltinESMExports()` reaches a module's `import * as fs` namespace under node 26 (the call threw the mock's `EPERM`) but not under bun 1.4 (it threw the real `ENOENT`).

A full `bun test` on a Mac running on battery lets the machine drop into deep-idle sleep mid-run, and every test asleep past its timeout reports `Received: -1` or a timeout, in a different set each run: at `44b3725` two such runs failed 15 and 8 tests while `pmset -g log` showed deep-idle sleep throughout. Run the full suite as `caffeinate -i bun test`; on battery at load average about 5 that run printed `787 pass` / `2 fail`, the two `tests/daemon.test.ts` timing tests above.
