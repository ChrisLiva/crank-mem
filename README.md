# crank-mem

Zero-runtime-dependency project memory for coding agents (Claude Code +
Codex). Maintains a token-annotated file anatomy index, an agent-written
cerebrum, and a session journal, injected at session start; Claude Code
subagents get a 2 KB cerebrum excerpt; re-indexes on writes. Advisory-only — hooks always exit 0.

## Install

```sh
git clone <this repo> ~/GitHub/crank-mem
ln -s ~/GitHub/crank-mem/bin/crank-mem ~/.local/bin/crank-mem
cd <your project> && crank-mem init
```

Upgrade = `git pull` in the clone, then `crank-mem upgrade` in each project
(re-vendors the hooks copied into `.crank/hooks/`, adds missing hook wiring,
and removes crank hooks from the Claude settings file the git mode does not use).

Requires bun, or node >= 23.6 (runs TypeScript directly; no build step).

## Commands

- `crank-mem init` — wire hooks into `.claude`/`.codex`, seed `.crank/`, first scan
- `crank-mem scan` — full index rebuild
- `crank-mem stats` — index report; memory health (cerebrum bullets injected against total, the oldest one left out, cited paths that still exist, overlapping bullet pairs, journal entries without `NEXT:`, days since the last audit, nudge counts from `debug.log`); whether Codex threads got the injection and whether its hook trust is current
- `crank-mem upgrade` — re-vendor hooks and repair their wiring after a `git pull`
- `crank-mem uninstall` — remove all wiring, offer backup restore

## Layout under `.crank/`

`anatomy-index.json` (data), `anatomy.md` (human/agent view), `cerebrum.md`
(agent-written semantic memory), `cerebrum-archive.md` (entries a prune moved
out; never injected), `journal.md` (agent-written session log, last 20 bullets
kept), `config.json`, `hooks/` (vendored), `backups/` (init/upgrade snapshots,
plus `backups/cerebrum/`: the last 5 copies of cerebrum.md, taken before each
prune nudge).

## What gets indexed

In a git repo the file list comes from `git ls-files -co --exclude-standard`,
so gitignored files stay out. Two groups of files go first: files an agent
wrote (up to 100, most recent first) and the 100 files changed most often in
the last 300 commits, not counting commits that touch more than 50 files.
crank-mem recomputes that churn list only when HEAD moves. Source code comes
next, and anything under `deps_src`, `third_party`, `vendor`, `external`,
`node_modules`, `resources`, `assets`, `static` or `public` ranks last; the
first `max_files` (default 500) are indexed. A written file stays pinned until
it shows up in the churn list. `anatomy.md` opens with the 25 most active of
these files. Submodule contents are not indexed. A write to a gitignored file
is indexed by the write hook and dropped again at the next session start.
Outside git, or if git fails, a sorted directory walk is used instead.
When the cap cuts files, the session-start injection says so and, in git,
gives the indexed count against the total; `crank-mem stats` counts every
indexable file without the cap.

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
in Codex. When the skill is installed, a cerebrum or journal nudge that is
already due also asks the agent to suggest an audit to you, at most once every
7 days and not within 7 days of the last audit. An audit is dated by its
backup directory under `.crank/backups/`, the one without a `manifest.json`.

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
cerebrum/journal nudge fired; `source` says whether git or the index did the
counting), `git-changes-failed` (why the count fell back to the index),
`walk-fallback` (git listing failed, so the directory walk ran),
`churn-skipped` (no churn list, for example before the first commit).

`CRANK_DEBUG=0` forces it off. The log is gitignored, capped at 1 MB then
restarted, never contains sensitive paths, and can never fail a session — a
write error is swallowed like any other advisory failure.

See `docs/adr/` for probe-verified agent behavior this design rests on.
