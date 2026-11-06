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

## Install

```sh
git clone <this repo> ~/GitHub/crank-mem
ln -s ~/GitHub/crank-mem/bin/crank-mem ~/.local/bin/crank-mem
crank-mem setup          # once per machine: packages, the dashboard build and the local search model
cd <your project> && crank-mem init
```

`setup` installs the clone's packages, then the `dashboard/` packages, builds
the dashboard into `dashboard/dist/` and stamps the build with the clone's
version, then downloads the search model.

Upgrade = `git pull` in the clone, then `crank-mem upgrade` in each project.
It re-vendors the hooks copied into `.crank/hooks/`, installs the clone's
packages, rebuilds the dashboard when its build stamp is not the clone's
version (a failed build prints a warning and the upgrade goes on), adds the
`Bash(crank-mem search *)`, `Bash(crank-mem timeline *)`,
`Bash(crank-mem get *)`, `Bash(crank-mem outline *)` and `Bash(crank-mem unfold *)` allow rules to the wired Claude settings file, adds hook wiring the install lacks (such as `SubagentStart`), rewrites hook commands crank-mem
wrote to the current form, and removes crank hooks from the Claude settings
file the git mode does not use, since wiring in both runs every hook twice.
A hook command you edited stays as written. It replaces a `.crank/.gitignore`
that is not the current allowlist, which admits only crank-mem's tracked files
to git. In commit mode it also removes
crank-mem's own `.crank/` ignore block, left by an earlier ignore or exclude
mode init, so `cerebrum.md` can be tracked. In ignore or exclude mode it adds
the `.crank/` ignore block back to `.gitignore` or `.git/info/exclude` when
it is missing. An upgrade that changes nothing
writes no backup.

Hook commands are guarded, `[ ! -f <script> ] || bun <script>`, so a clone or
worktree that has the committed settings file but no `.crank/hooks/` exits 0
instead of reporting a hook error. Codex hashes each hook command for its
trust check, so the first upgrade that rewrites the Codex commands makes
Codex ask once for a hooks review: open codex in the project and accept it.
An install made with `--codex-trust write` skips that, because upgrade
recomputes the trusted hashes.

Requires bun, or node >= 23.6 (runs TypeScript directly). The dashboard is the
one built part, and `crank-mem setup` builds it. Hooks
import only `node:` modules. Three packages each load only when a command needs
them: `@huggingface/transformers` for search by meaning, and `web-tree-sitter`
with `@vscode/tree-sitter-wasm` for `outline` and `unfold`.

## Commands

- `crank-mem init` — wire hooks into `.claude`/`.codex`, add the `Bash(crank-mem search *)`, `Bash(crank-mem timeline *)`, `Bash(crank-mem get *)`, `Bash(crank-mem outline *)` and `Bash(crank-mem unfold *)` allow rules to the Claude settings file so agents run the recall and code-reading commands without a prompt, seed `.crank/`, first scan; removes crank hooks from the other Claude settings file
- `crank-mem scan` — full index rebuild
- `crank-mem digest on|off|resume` — turn background digests on or off for this checkout, a switch kept in the gitignored `.crank/config.local.json`; `resume` clears a stop and restarts the daemon
- `crank-mem search <query>` — search stored memory by meaning or keyword (`--limit`, `--type`, `--since YYYY-MM-DD`, `--file`, and `--stale` to include observations flagged stale, marked `[stale]`); keyword only until `setup` has run
- `crank-mem timeline <id>` — the observations around one id (`--depth`)
- `crank-mem get <id...>` — print stored observations in full, with the date and reason of a stale flag
- `crank-mem outline <file>` — print a source file's symbols as folded source with start-end line ranges, members under their class; a long outline ends with a `--from <line>` command for the next page
- `crank-mem unfold <file> <symbol|line>` — print one symbol in full with line numbers and its doc comment, by bare or qualified name or by any line inside it; every match prints
- `crank-mem restore-memory [<file>]` — put a `memory.db` snapshot back: the named file, or the newest one in `.crank/backups/memory/`. It checks the snapshot's integrity and schema version, saves the current store as a snapshot first so the restore can be undone, then migrates the restored store to this version
- `crank-mem setup` — install the clone's packages, build the dashboard into `dashboard/dist/`, and download the local search model into `~/.crank/models`
- `crank-mem stats` — index report; memory health (cerebrum bullets injected against total, preferences left out, the oldest bullet left out, cited paths that still exist, days since the last audit); capture health (digest on, off or stopped, daemon, spool waiting and parked, store counts, last digest, the month's cost at list price, pending `proposals`, `stale` rows, the last `consolidation` and its outcome, `last snapshot`, embedder); whether Codex threads got the injection and whether its hook trust is current
- `crank-mem dashboard` — serve a read-only memory dashboard on `127.0.0.1` until Ctrl-C: each registered project's Memory, Curation, Health and Usage views. It prints `crank-mem dashboard: http://127.0.0.1:<port>/?token=<token>` and opens that URL in the browser; the token, kept in `~/.crank/dashboard.json`, trades for a session cookie. `--port <n>` picks the port (default `38700` plus your uid mod 100), and `--no-open` skips the browser. It refuses until `setup` has built the dashboard
- `crank-mem upgrade` — re-vendor hooks and repair their wiring after a `git pull`, rebuild the dashboard when its build is for another version, and add the project to `~/.crank/projects.json`, the list the dashboard shows
- `crank-mem uninstall` — remove all wiring, offer backup restore; `--delete-crank` deletes only the files crank-mem writes in `.crank/`, `memory.db` and its `-wal` and `-shm` files included, and removes the directory only when nothing else is left in it

## Layout under `.crank/`

`anatomy-index.json` (data), `anatomy.md` (human/agent view), `cerebrum.md`
(semantic memory, kept by consolidation), `cerebrum-archive.md` (bullets
consolidation removed or replaced, each with its reason; never injected),
`memory.db` (digested memory, kept out of git), `config.json`, `config.local.json` (the per-checkout digest switch, kept out of git), `hooks/` (vendored), `backups/` (init/upgrade snapshots,
plus `backups/cerebrum/`: the last 5 copies of cerebrum.md, taken before each
consolidation edit, and `backups/memory/`: the daily snapshots of
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

## Subagents

Claude Code fires `SessionStart` only in the main session, so crank-mem wires
`SubagentStart` too. Each `general-purpose`, `Explore`, `Plan` and
`workflow-subagent` subagent gets a 2,048-byte cerebrum excerpt, split between
preferences and the newest memory bullets, a pointer to `cerebrum.md`, a
pointer to `crank-mem outline` and `unfold`, and, when the project has a
readable `memory.db` or digests are running, a recall pointer to
`crank-mem search`, `timeline` and `get`; custom and plugin agents get nothing. The parent session does not see it. See ADR 0007.

## Digests

`crank-mem digest on` turns digests on for a checkout of a project. It writes
the switch to the gitignored `.crank/config.local.json`, so a teammate's clone
or a linked worktree stays off until someone runs it there. Claude Code's Stop and
SessionEnd hooks then drop a signal for the session into a per-user spool under
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

Nothing asks the agent to keep memory, whether digests run or not: session
start injects no cerebrum or journal protocol, and Stop and post-write add
nothing the model sees (ADR 0010). A `journal.md` from an earlier release stays
on disk unread.

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
reviewed, and the bullets whose cited files changed or went missing since the
last consolidation that succeeded. A second `claude -p` run checks them against the code with
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

## What gets indexed

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

## Audit skill

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
`.crank/backups/`, the one that holds only copies of the memory files:
`cerebrum.md`, `journal.md` and `cerebrum-archive.md`.

## Debugging

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

See `docs/adr/` for probe-verified agent behavior this design rests on.
