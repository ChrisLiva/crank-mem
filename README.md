# crank-mem

Project memory for coding agents (Claude Code + Codex). Maintains a
token-annotated file anatomy index and a cerebrum, `.crank/cerebrum.md`,
injected at session start; Claude Code subagents get a 2 KB cerebrum excerpt;
re-indexes on writes. With digests on, Claude Code sessions are digested
automatically into a per-project store, `.crank/memory.db`, that agents search
with `crank-mem search`, `timeline` and `get`, and that shows up at session
start and when an agent reads a file it covers. After a digest, consolidation
checks what sessions proposed against the code and keeps `cerebrum.md`; no
hook asks the agent to keep memory. Advisory-only — hooks always exit 0.

## For users

### Install

```sh
curl -fsSL https://github.com/ChrisLiva/crank-mem/releases/latest/download/install.sh | sh
cd <your project> && crank-mem init
```

The installer downloads the latest release into `~/.crank/versions/<version>`,
checks it against its `.sha256` (a mismatch installs nothing), then runs that
version's `crank-mem self-install`. It installs the release's production
packages, points `~/.crank/current` at the version, links `crank-mem` into
`~/.local/bin`, downloads the local search model, and offers to add the bin
dir to your shell's rc file when it is not on PATH. Pass flags after `sh -s --`:
`--to v<version>` installs that tagged release instead of the latest,
`--bin-dir <dir>` links `crank-mem` into another directory, and `--yes`
accepts every question:

```sh
curl -fsSL https://github.com/ChrisLiva/crank-mem/releases/latest/download/install.sh | sh -s -- --to v0.12.0 --bin-dir ~/bin
```

Run over an install from a clone, `self-install` replaces a `crank-mem` link
that points into the clone and offers to repoint every registered project at
`~/.crank/current`.

To update, run `crank-mem self-update`, or `crank-mem self-update --to vX.Y.Z`
for a tagged release. It installs the release next to the running one, points
`~/.crank/current` at it, then runs the new version's `crank-mem upgrade --all`,
which repairs every project in `~/.crank/projects.json`. The previous version
stays installed, and `crank-mem rollback` returns to it and repairs every project
with it. Going back to an older version, by `rollback` or `self-update --to`,
refuses when a project's memory store has a schema newer than that version reads:
it names those projects and points to `crank-mem restore-memory`.

crank-mem checks for a newer release on its own: the daemon checks when it
starts and the last check is over 24 h old, and the dashboard checks when it
starts and every 24 h after. `crank-mem self-update --check` checks now and
prints the installed and latest versions. `crank-mem self-update --check-daily off`
or `CRANK_NO_UPDATE_CHECK=1` turns the automatic checks off. With
`crank-mem self-update --auto on`, the daemon applies a newer release between
digest jobs, so auto mode acts only while digests are on (`crank-mem digest on`).
The last check and these settings live in `~/.crank/update.json`.

`crank-mem upgrade` in one project repairs that project. It adds the
`Bash(crank-mem search *)`, `Bash(crank-mem timeline *)`,
`Bash(crank-mem get *)`, `Bash(crank-mem outline *)` and `Bash(crank-mem unfold *)` allow rules to the wired Claude settings file, adds hook wiring the install lacks (such as `SubagentStart`), rewrites hook commands crank-mem
wrote to the current form, and removes crank hooks from the Claude settings
file the git mode does not use, since wiring in both runs every hook twice.
It brings every item back to the choices init recorded in `.crank/config.json`:
when init wired Codex it re-wires `.codex/hooks.json` and the `[features]`
snippet in `.codex/config.toml`, it re-vendors `.crank/hooks/` whenever it differs from the running crank-mem,
and it re-seeds a missing `cerebrum.md`. When init recorded `--codex-trust write`, it
recomputes the trusted hashes only when one is missing or outdated. A failed
repair prints a warning, every other repair still runs, and the upgrade exits 1.
A hook command you edited stays as written. It replaces a `.crank/.gitignore`
that is not the current allowlist, which admits only crank-mem's tracked files
to git. In commit mode it also removes
crank-mem's own `.crank/` ignore block, left by an earlier ignore or exclude
mode init, so `cerebrum.md` can be tracked. In ignore or exclude mode it adds
the `.crank/` ignore block back to `.gitignore` or `.git/info/exclude` when
it is missing. An upgrade that changes nothing
writes no backup.

Hook commands are guarded, `[ ! -f <script> ] || bun <script>`, so a
checkout that has the committed settings file but no `.crank/hooks/` exits 0
instead of reporting a hook error. Codex hashes each hook command for its
trust check, so the first upgrade that rewrites the Codex commands makes
Codex ask once for a hooks review: open codex in the project and accept it.
An install made with `--codex-trust write` skips that, because upgrade
recomputes the trusted hashes.

Requires bun, or node >= 23.6 (runs TypeScript directly).

### Commands

- `crank-mem init` — wire hooks into `.claude`/`.codex`, add the `Bash(crank-mem search *)`, `Bash(crank-mem timeline *)`, `Bash(crank-mem get *)`, `Bash(crank-mem outline *)` and `Bash(crank-mem unfold *)` allow rules to the Claude settings file so agents run the recall and code-reading commands without a prompt, seed `.crank/` with the project named after its folder (`-2`, `-3`, … added when another installed project has that name; set `name` in `.crank/config.json` to change it), first scan; removes crank hooks from the other Claude settings file
- `crank-mem scan` — full index rebuild
- `crank-mem digest on|off|resume` — turn background digests on or off for this checkout, a switch kept in the gitignored `.crank/config.local.json`; `resume` clears a stop and restarts the daemon
- `crank-mem search <query>` — search stored memory by meaning or keyword (`--limit`, `--type`, `--since YYYY-MM-DD`, `--file`, `--project <name>` to search only that project's store, and `--stale` to include observations flagged stale, marked `[stale]`); keyword only until `setup` has run
- `crank-mem timeline <id>` — the observations around one id (`--depth`)
- `crank-mem get <id...>` — print stored observations in full, with the date and reason of a stale flag
- `crank-mem outline <file>` — print a source file's symbols as folded source with start-end line ranges, members under their class; a long outline ends with a `--from <line>` command for the next page
- `crank-mem unfold <file> <symbol|line>` — print one symbol in full with line numbers and its doc comment, by bare or qualified name or by any line inside it; every match prints
- `crank-mem restore-memory [<file>]` — put a `memory.db` snapshot back: the named file, or the newest one in `.crank/backups/memory/`. It checks the snapshot's integrity and schema version, saves the current store as a snapshot first so the restore can be undone, then migrates the restored store to this version
- `crank-mem setup` — install crank-mem's packages, build the dashboard into `dashboard/dist/`, and download the local search model into `~/.crank/models`; an installed copy installs only production packages and skips the dashboard build, since its release ships one
- `crank-mem stats` — index report; memory health (cerebrum bullets injected against total, preferences left out, the oldest bullet left out, cited paths that still exist, days since the last audit); capture health (a status line naming the first problem and the command that fixes it, digest on, off or stopped, daemon, spool waiting and parked, store counts, last digest, the month's cost at list price, pending `proposals`, `stale` rows, the last `consolidation` and its outcome, `last snapshot`, embedder); repos sessions touched that have no crank-mem install (`not installed`); whether Codex threads got the injection and whether its hook trust is current
- `crank-mem dashboard` — serve a read-only memory dashboard on `127.0.0.1` until Ctrl-C: a Health board of every registered project (capture status, the command that fixes a stalled one, cost and 30-day digests), then each project's Health, Curation, Usage and Memory views, with per-day charts in Health and Usage. It prints `crank-mem dashboard: http://127.0.0.1:<port>/?token=<token>` and opens that URL in the browser; the token, kept in `~/.crank/dashboard.json`, trades for a session cookie. `--port <n>` picks the port (default `38700` plus your uid mod 100), and `--no-open` skips the browser. It refuses until `setup` has built the dashboard
- `crank-mem upgrade [--all]` — re-vendor hooks and repair their wiring after an update, and add the project to `~/.crank/projects.json`, the list the dashboard shows; `--all` installs crank-mem's packages once, then repairs every project in that list, skipping a missing root and a project whose anatomy lock is held
- `crank-mem self-update [--to vX.Y.Z]` — install the latest release, or the tagged one, make it the current version and repair every registered project with it; the previous version stays installed and older ones are removed, except the one this process, a live daemon or a live dashboard runs. It refuses in a clone, which updates with `git pull`
- `crank-mem rollback` — make the previous installed version the current one and repair every registered project with it. It refuses when a project's memory store has a schema newer than that version reads, naming the projects and `crank-mem restore-memory`, and refuses in a clone
- `crank-mem self-uninstall` — remove the installed crank-mem: stop the daemon, offer to run `crank-mem uninstall` in every registered project (`--yes` accepts), then remove `~/.crank/versions/`, the `current` link, the `crank-mem` link in the bin dir (`--bin-dir <dir>`, default `~/.local/bin`) and the PATH block in your shell rc file. `--purge` also removes the state crank-mem keeps in `~/.crank` (the spool, models, registry, dashboard token and daemon files) and nothing another tool keeps there
- `crank-mem uninstall` — remove all wiring, offer backup restore: `--restore` puts each project file crank-mem changed back as it was before crank-mem first changed it and deletes the files crank-mem created, while files outside the project, such as `~/.codex/config.toml`, only lose crank-mem's entries; `--delete-crank` deletes only the files crank-mem writes in `.crank/`, `memory.db` and its `-wal` and `-shm` files included, and removes the directory only when nothing else is left in it; it exits 1, naming the file, when it cannot remove crank-mem's entries from a file (one that is not valid JSON, or one it cannot read or write)

### Layout under `.crank/`

`anatomy-index.json` (data), `anatomy.md` (human/agent view), `cerebrum.md`
(the cerebrum, kept by consolidation), `cerebrum-archive.md` (bullets
consolidation removed or replaced, each with its reason; never injected),
`memory.db` (digested memory, kept out of git), `config.json`, `config.local.json` (the per-checkout digest switch, kept out of git), `hooks/` (vendored), `backups/` (init/upgrade backups,
plus `backups/cerebrum/`: the last 5 copies of cerebrum.md, taken before each
consolidation edit and before an upgrade replaces the 0.8.1 template preamble, and `backups/memory/`: the daily snapshots of
`memory.db`), `usage.jsonl` (the always-on usage log, kept out of git: one line
per session start, subagent start and file read the hooks handle, and per
`search`, `timeline`, `get`, `outline` and `unfold` run; at 4 MiB it rotates
to `usage.1.jsonl`, replacing the older one). A `journal.md` from an earlier
release stays on disk, but nothing reads or writes it.

`.crank/.gitignore` is an allowlist: it ignores everything in `.crank/` except
`config.json`, `cerebrum.md`, `cerebrum-archive.md`, `journal.md`,
`anatomy.md`, `anatomy-index.json` and `hooks/`. In commit mode, backups, the
lock file, the debug log and files another tool writes into `.crank/` stay
out of git. `init` backs up a `.crank/.gitignore` that another tool wrote
before replacing it.

### Subagents

Claude Code fires `SessionStart` only in the main session, so crank-mem wires
`SubagentStart` too. Each `general-purpose`, `Explore`, `Plan` and
`workflow-subagent` subagent gets a 2,048-byte cerebrum excerpt, split between
preferences and the newest memory bullets, a pointer to `cerebrum.md`, a
pointer to `crank-mem outline` and `unfold`, and, when the project has a
readable `memory.db` or digests are running, a recall pointer to
`crank-mem search`, `timeline` and `get`; custom and plugin agents get nothing. The parent session does not see it. See ADR 0007.

### Digests

`crank-mem digest on` turns digests on for a checkout of a project. It writes
the switch to the gitignored `.crank/config.local.json`, so a teammate's checkout
or a linked worktree stays off until someone runs it there. Claude Code's Stop and
SessionEnd hooks then write the session's entry into a per-user spool under
`~/.crank` (or `$CRANK_HOME`), which crank-mem creates at mode 0700; a
directory that already exists keeps its mode. They also start a small detached
daemon, one per user, which runs one digest job at a time across all projects
and exits when idle. A job reads the session's new transcript records, removes
`<private>` and `<system-reminder>` blocks, redacts secrets (always on, with no
setting to turn it off), asks Haiku for typed observations and a summary,
stores them in `.crank/memory.db`, and embeds them locally for search by
meaning.

Digests run the unmodified `claude` binary on your own Claude login; any other credential stops them until `crank-mem digest resume`.
The run gets only `HOME`, `USER`, `PATH`, `TMPDIR` and
`CLAUDE_CODE_MAX_RETRIES=0` from the environment, and no tools, hooks or MCP
servers (ADR 0008). `crank-mem stats` shows the month's digest cost at list
price. Codex sessions are not digested.

Nothing asks the agent to keep memory, whether digests run or not (ADR 0010).

A session still running is digested too: the daemon digests a live session 2
hours after it first sees it, then 2 hours after each digest of it, so a long
session reaches memory before it ends.

A digest also proposes `cerebrum.md` bullets and flags earlier observations
the session showed to be wrong or replaced. Search, session start and file
history leave flagged observations out; `crank-mem search --stale` includes
them, and `crank-mem get` shows the flag.

After a digest, consolidation runs when the project has a `cerebrum.md` and
something waits for it, at most once every 2 hours per project. It reads
`cerebrum.md`, up to 20 pending proposals, up to 20 stale flags not yet
reviewed, and the bullets whose cited files changed since the last consolidation
that succeeded (before one, since the bullet's own date) and, until the first one succeeds,
those citing a missing file. A second `claude -p` run checks them against the code with
read-only `Read`, `Grep` and `Glob` tools over the project, under deny rules
that keep the files crank-mem never indexes out of reach (ADR 0011). It
accepts or rejects each proposal, confirms or clears each flag, and edits
`cerebrum.md`, skipping any added bullet that would take the file past 150
lines or 3,000 tokens. Before an edit it copies the file to `.crank/backups/cerebrum/`,
and it appends each bullet it removes or replaces, with the reason, to
`cerebrum-archive.md`.

Once a day, after a digest, crank-mem snapshots `memory.db` into
`.crank/backups/memory/` and keeps the newest 7 daily snapshots. `crank-mem
restore-memory` puts one back.

The same daily pass deletes observations flagged stale more than 90 days ago,
so a flag left standing for 90 days ends that observation's retention.

### What gets indexed

When the project root holds `.git`, the file list comes from
`git ls-files -co --exclude-standard`, so gitignored files stay out. Two
groups of files go first: files an agent wrote (up to 100, most recent first)
and the 100 files changed most often in the last 300 commits, not counting
commits that touch more than 50 files. crank-mem recomputes that churn list
only when HEAD moves. Source code comes next, and anything under `deps_src`,
`third_party`, `vendor`, `external`, `node_modules`, `resources`, `assets`,
`static` or `public` ranks last; the first `max_files` (default 500) are
indexed. A written file stays pinned until it shows up in the churn list.
`anatomy.md` opens with the 25 most active of these files. Submodule contents
are not indexed. A write to a gitignored file is indexed by the write hook and
dropped again at the next session start. When the root has no `.git`, or git
fails, a sorted directory walk is used instead, and it does not read
`.gitignore`. That includes a project initialized in a subdirectory of a repo,
such as `packages/web` in a monorepo: it also gets no churn ranking. When the cap cuts files, the session-start injection says so and, in
git, gives the indexed count against the total; `crank-mem stats` counts every
indexable file without the cap.

### Audit skill

A bundled agent skill, `crank-mem-audit`, reconciles memory with reality: it
mines recent Claude Code and Codex sessions (it asks how many days back to
check; default 5), verifies every cerebrum bullet against the current code,
then backs up and rewrites `cerebrum.md`. Between audits, consolidation
maintains the cerebrum after each digest (see Digests). Install it into a project with the
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
in Codex. An audit is dated by its backup directory under
`.crank/backups/`, the one that holds only a copy of `cerebrum.md`
(older audits may also hold `journal.md` and `cerebrum-archive.md`).

### Debugging

Hooks are advisory-only and silent by design. Their stderr reaches only the
terminal, never the model, so a failing hook leaves no record in the project.
Turn on a per-run JSONL trace when something looks wrong:

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
removed/partial counts), `injected` (bytes vs. budget, plus estimated tokens), `reindex`
(`committed:false` means the write did not land), `lock-timeout` (contention —
the only way to tell it apart from "nothing to write"), `walk-fallback` (git listing failed, so the directory walk ran),
`churn-skipped` (no churn list, for example before the first commit).

`CRANK_DEBUG=0` forces it off. The log is gitignored, capped at 1 MB then
restarted, never contains sensitive paths, and can never fail a session — a
write error is swallowed like any other advisory failure.

## For development

### From a clone

```sh
git clone <this repo> ~/GitHub/crank-mem
ln -s ~/GitHub/crank-mem/bin/crank-mem ~/.local/bin/crank-mem
crank-mem setup          # once per machine: packages, the dashboard build and the local search model
cd <your project> && crank-mem init
```

`setup` installs the clone's packages, then the `dashboard/` packages, builds
the dashboard into `dashboard/dist/` and stamps the build with the clone's
version, then downloads the search model.

Projects initialized from a clone record the clone, not `~/.crank/current`.
To update, `git pull` in the clone, then `crank-mem upgrade --all`. In a clone
`upgrade` also installs the clone's packages and rebuilds the dashboard when
its build stamp is not the clone's version; a failed build prints a warning
and the upgrade goes on. `self-install` and `self-uninstall` refuse to run
from a clone.

### Checks

- `bun test` — the whole suite; it needs `crank-mem setup` run once on the
  machine, since some tests read the real search model and the
  `dashboard/node_modules` it installs
- `bun run typecheck` — `tsc` over the CLI and the dashboard
- `bun run format:check` — oxfmt; `bun run format` rewrites
- `bun run lint:health` — knip (dead code, `knip.json`) then fallow
  (cognitive complexity over 15, `.fallowrc.json`); the release `check` job
  and `scripts/release.ts` run it

Run the full suite as `caffeinate -i bun run test`: four parallel workers,
then the `*.serial.test.ts` files. `docs/testing-load.md` holds the baseline
and how to read a timeout under load.

### Dashboard build

The page is a Vite + React package in `dashboard/`, the one built part.
`cd dashboard && bun run build` empties `dashboard/dist/` and drops its
`.crank-version` stamp, so `crank-mem dashboard` refuses until
`crank-mem setup` or `crank-mem upgrade` restamps it. Hooks import only
`node:` modules. Three packages each load only when a command needs them:
`@huggingface/transformers` for search by meaning, and `web-tree-sitter` with
`@vscode/tree-sitter-wasm` for `outline` and `unfold`.

### Releasing

A `v*` tag push runs `.github/workflows/release.yml`, which checks the tag
against `package.json`, packs the release, smoke-installs it on Linux and
macOS and publishes the GitHub Release. The steps are in `docs/releasing.md`.

See `docs/adr/` for probe-verified agent behavior this design rests on.
