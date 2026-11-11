# 0013 — Releases ship as one tarball per tag, installed under `versions/` behind `current`

Date: 2026-11-10. Status: accepted.

## Context

Until 0.12.0, the only way to install crank-mem was a clone: `git clone`, an `ln -s` of
`bin/crank-mem` onto PATH, then `crank-mem setup` to install packages, build the dashboard
and download the search model. Updating meant `git pull` in the clone and `crank-mem upgrade`
in each project. Every project records the tool's location as `clone_root` in
`.crank/config.json`, which `ensureDaemon` reads to start the daemon and `driftNote` reads to
compare vendored hooks.

An installed layout has to give projects a path that survives an update, but `REPO_ROOT`
(`src/cli/version.ts`) resolves symlinks. A probe ran a script that prints its `REPO_ROOT`
through `current -> versions/1.0.0`, as a directory link and as a file link, under bun 1.4.4
and node v26.13.0:

```
bun|node <scratch>/current/src/cli/v.ts   exit 0
.../symprobe/versions/1.0.0
```

So a project that recorded `REPO_ROOT` would pin the version it was installed with, and an
update would leave its daemon start and drift check on the old copy.

## Decision

- **One platform-neutral tarball per `v*` tag.** `scripts/pack-release.ts` packs `bin/`,
  `src/`, `package.json`, `bun.lock`, `README.md` and a prebuilt `dashboard/dist/` stamped
  with the version, with no `node_modules`. The GitHub Release carries
  `crank-mem.tar.gz`, `crank-mem.tar.gz.sha256`, `release.json` and `install.sh`;
  `.github/workflows/release.yml` publishes them after a smoke install on Linux and macOS.
- **`versions/X.Y.Z` plus `current`.** `install.sh` checks the tarball against its `.sha256`,
  unpacks it into `<crank home>/versions/X.Y.Z` and runs that copy's `crank-mem self-install`,
  which installs production packages (`bun install --production --frozen-lockfile`), checks
  the shipped dashboard build, points `<crank home>/current` at the version and links
  `crank-mem` into the bin dir through `current`. An installed copy never builds the
  dashboard.
- **`clone_root` is `toolRoot()`.** `toolRoot()` returns `<crank home>/current` when the
  running copy is installed (`installedCopy()`), and `REPO_ROOT` otherwise, so projects, the
  PATH link and the daemon follow `current` across updates.
- **The release check reads `release.json`.** It fetches
  `<base>/latest/download/release.json` (`{ version, tag, releasedAt }`), not the GitHub REST
  API: one base URL, `CRANK_RELEASE_URL`, serves downloads and checks, with no rate limit,
  and tests point it at a local server.
- **Update notices go to human channels only**: `stats`, stderr of `init`, `upgrade`,
  `setup`, `digest` and `dashboard` startup, and a display-only dashboard section. No hook
  prints one and neither do the recall and code-reading commands, so no notice is
  model-visible (ADR 0001).

## Consequences

- An update keeps two versions, the current one and one previous, so `crank-mem rollback`
  can flip `current` back; it never deletes the version a live daemon runs.
- A rollback can meet a store migrated by the newer version. It reads the previous version's
  `SCHEMA_VERSION` and each registered store's `PRAGMA user_version`, and refuses, naming the
  projects and `crank-mem restore-memory`, when a store's schema is newer.
- A clone still works as dev mode: run from a clone, `toolRoot()` is the clone, projects
  record it, and `self-install`, `self-update`, `rollback` and `self-uninstall` refuse to run.
  Following `main` stays a clone; there is no rolling prerelease.
