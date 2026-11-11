# Releasing

A `v*` tag push runs `.github/workflows/release.yml`. Its `check` job refuses a tag that is
not `v` + `package.json` → `version` and runs `bun run typecheck` and
`bun run format:check`; `pack` builds and stamps the dashboard and packs the release with
`scripts/pack-release.ts`; `smoke` installs it with `install.sh` on ubuntu and macOS, inits a
project, runs its session-start hook and `crank-mem stats`; `release` publishes the GitHub
Release with generated notes and four assets: `crank-mem.tar.gz`,
`crank-mem.tar.gz.sha256`, `release.json` and `install.sh`.

The workflow does not run the test suite, so run it before tagging.

Run `bun run release <patch|minor|major|X.Y.Z>` on `main` (`scripts/release.ts`). It
refuses unless `main` is checked out, has no tracked changes and is not behind `origin/main`, and
the new tag is on neither side; asks once before it changes anything (`--yes` answers); then:

1. Runs the gates: `bun run typecheck`, `bun run format:check` and `bun run test` (under
   `caffeinate -i` where it exists). A failing gate stops the release with nothing changed;
   re-run a failing test file alone with `bun test <file>` per `docs/testing-load.md` →
   `## How to read a failure`.
2. Bumps `package.json` → `version` to the new version.
3. Commits the bump as `chore(release): v<version>`.
4. Tags it `v<version>`.
5. Pushes `main` and the tag together (`git push --atomic origin main v<version>`). A failed
   push leaves the commit and tag only local and prints the retry and undo commands.
6. Watch the `release` workflow on GitHub. A red `check` usually means the tag and
   `package.json` disagree: delete the tag (`git tag -d v<version>`,
   `git push origin :refs/tags/v<version>`), fix, and tag again.
