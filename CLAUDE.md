# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

- `bun test` — run all tests
- `bun test tests/scanner.test.ts` — run one test file
- `bun test -t "pattern"` — run tests matching a name
- `bun run typecheck` — `tsc --noEmit`

There is no build step. `bin/crank-mem` is a shell launcher that runs `src/cli/main.ts` directly under bun (or node >= 23.6, which also executes TypeScript natively). The project has **zero runtime dependencies** — only `node:` imports are allowed in `src/`; keep it that way.

## What this is

Project memory for coding agents (Claude Code + Codex): a token-annotated file anatomy index plus an agent-written `cerebrum.md`, injected at session start and silently re-indexed on writes. Installed into a target project as `.crank/` (index, anatomy.md, cerebrum.md, config.json, vendored hooks, backups).

## Architecture

Two entry surfaces share one core:

- **CLI** (`src/cli/`) — `main.ts` dispatches to per-command modules (`init`, `scan`, `stats`, `upgrade`, `uninstall`) via dynamic imports. Runs from the clone.
- **Hooks** (`src/hooks/session-start.ts`, `src/hooks/post-write.ts`, `src/hooks/stop.ts`) — invoked by the agents with a JSON payload on stdin. `init` vendors a recursive copy of `src/hooks/` (including `lib/`) into `<project>/.crank/hooks/` (`src/cli/vendor.ts`), so hooks run self-contained inside each target project while the CLI imports the same `lib/` from the clone. Consequence: everything under `src/hooks/` must work from either location and import nothing outside `src/hooks/`. The cerebrum nudge reaches each agent by its best non-blocking channel: Claude at turn end via `stop.ts`, Codex after a write via `post-write.ts` (Codex Stop has no usable channel — ADR 0004).

The shared core is `src/hooks/lib/`: `scanner.ts` (index refresh with time budget), `store.ts` (anatomy-index.json load/save + anatomy.md render), `injection.ts` (session-start context assembly under a token budget), `cerebrum-nudge.ts` (debounced "record what you learned" reminder shared by stop.ts and post-write.ts), `symbols.ts` / `tokens.ts` / `describe.ts` (per-file analysis), `config.ts` (.crank/config.json + always-on sensitive-file filter), `lock.ts` (cross-process lock around index writes), `hook-io.ts` (stdin parsing, project-root discovery, `additionalContext` emission), `apply-patch.ts` (Codex patch-text parsing), `debug.ts` (opt-in per-run JSONL trace to `.crank/debug.log`, off by default).

### Invariants

- **Hooks are advisory-only: every path exits 0.** Never let a hook throw, block, or emit errors that could break an agent session. A corrupt or missing index degrades to `emptyIndex()` and reconverges on the next scan.
- All index writes happen under `withLock`; hooks operate under hard time budgets (refresh budget, lock-wait budget) and report staleness in the injection rather than blocking.
- The sensitive-file filter in `config.ts` is not configurable — never index secrets.
- Model-visible output goes only through `hookSpecificOutput.additionalContext` on stdout; stderr is human/debug-only (see ADR 0001).
- Debug logging is subject to the same advisory-only contract: `debug.ts` never throws, never writes to stdout, and never records a sensitive path.

### ADRs record probe-verified agent behavior

`docs/adr/` documents live-probed facts about Claude Code and Codex (which hook channels reach the model, Codex's trust-hash formula, Codex tool shapes — notably: Codex has no Read tool, and writes arrive as `apply_patch` patch text). Design decisions rest on these probes; don't change behavior they cover without re-probing (method is in each ADR), and record new probe findings as ADRs.

## Testing conventions

Tests are black-box: hooks are executed as real child processes with agent-like stdin payloads via `runHook` in `tests/helpers.ts`, against temp projects built by `makeCrankProject`. Agent payload fixtures live in `tests/fixtures/payloads.ts`. Prefer this style over importing hook internals — assertions should hold against exit status, stdout JSON, and on-disk `.crank/` state.
