# crank-mem

Zero-runtime-dependency project memory for coding agents (Claude Code +
Codex). Maintains a token-annotated file anatomy index, an agent-written
cerebrum, and a session journal, injected at session start; re-indexes on
writes. Advisory-only — hooks always exit 0.

## Install

```sh
git clone <this repo> ~/GitHub/crank-mem
ln -s ~/GitHub/crank-mem/bin/crank-mem ~/.local/bin/crank-mem
cd <your project> && crank-mem init
```

Upgrade = `git pull` in the clone, then `crank-mem upgrade` in each project
(re-vendors the hooks copied into `.crank/hooks/`).

Requires bun, or node >= 23.6 (runs TypeScript directly; no build step).

## Commands

- `crank-mem init` — wire hooks into `.claude`/`.codex`, seed `.crank/`, first scan
- `crank-mem scan` — full index rebuild
- `crank-mem stats` — index report
- `crank-mem upgrade` — re-vendor hooks after a `git pull`
- `crank-mem uninstall` — remove all wiring, offer backup restore

## Layout under `.crank/`

`anatomy-index.json` (data), `anatomy.md` (human/agent view), `cerebrum.md`
(agent-written semantic memory), `journal.md` (agent-written session log, last
20 bullets kept), `config.json`, `hooks/` (vendored), `backups/`.

## Audit skill

A bundled agent skill, `crank-mem-audit`, reconciles memory with reality: it
mines recent Claude Code and Codex sessions (it asks how many days back to
check; default 5), verifies every cerebrum bullet against the current code,
then backs up and rewrites `cerebrum.md` and `journal.md`. Install it into a project with the
[skills CLI](https://github.com/vercel-labs/skills):

```sh
cd <your project> && npx skills add ChrisLiva/crank-mem
```

Install at the **project level** — `.claude/skills/` for Claude Code and the
shared `.agents/skills/` for Codex (user-level Codex paths are inconsistent
between the docs and the installer). The installer writes a `skills-lock.json`
at the project root recording the source and content hash; update installed
copies with `npx skills update` (`crank-mem upgrade` never touches them).

Invocation is user-only: `/crank-mem-audit` in Claude Code, `$crank-mem-audit`
in Codex.

## Debugging

Hooks are advisory-only and silent by design — stderr never reaches the model
and in practice nobody reads it, so a failing hook leaves no trace. Turn on a
per-run JSONL trace when something looks wrong:

```sh
CRANK_DEBUG=1                      # one session, no config edit
# or "debug": true in .crank/config.json, for every session
```

Either writes `.crank/debug.log` — one record per hook run:

```json
{"ts":"…","hook":"post-write","ms":5,"ok":true,"events":[
  {"event":"reindex","tool":"Write","paths":["src/app.ts"],"committed":true}]}
```

`ok:false` carries the full stack. Useful events: `refresh` (changed/added/
removed/partial counts), `injected` (tokens vs. budget), `reindex`
(`committed:false` means the write did not land), `lock-timeout` (contention —
the only way to tell it apart from "nothing to write"), `nudge-skipped` (why no
cerebrum/journal nudge fired).

`CRANK_DEBUG=0` forces it off. The log is gitignored, capped at 1 MB then
restarted, never contains sensitive paths, and can never fail a session — a
write error is swallowed like any other advisory failure.

See `docs/adr/` for probe-verified agent behavior this design rests on.
