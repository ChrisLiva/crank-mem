# crank-mem

Zero-runtime-dependency project memory for coding agents (Claude Code +
Codex). Maintains a token-annotated file anatomy index and an agent-written
cerebrum, injected at session start; re-indexes on writes. Advisory-only —
hooks always exit 0.

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
(agent-written memory), `config.json`, `hooks/` (vendored), `backups/`.

See `docs/adr/` for probe-verified agent behavior this design rests on.
