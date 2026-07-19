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
the only way to tell it apart from "nothing to write"), `nudge-skipped` (which
of the four branches suppressed a cerebrum nudge).

`CRANK_DEBUG=0` forces it off. The log is gitignored, capped at 1 MB then
restarted, never contains sensitive paths, and can never fail a session — a
write error is swallowed like any other advisory failure.

See `docs/adr/` for probe-verified agent behavior this design rests on.
