# Releasing

A `v*` tag push runs `.github/workflows/release.yml`. Its `check` job refuses a tag that is
not `v` + `package.json` → `version` and runs `bun run typecheck` and
`bun run format:check`; `pack` builds and stamps the dashboard and packs the release with
`scripts/pack-release.ts`; `smoke` installs it with `install.sh` on ubuntu and macOS, inits a
project, runs its session-start hook and `crank-mem stats`; `release` publishes the GitHub
Release with generated notes and four assets: `crank-mem.tar.gz`,
`crank-mem.tar.gz.sha256`, `release.json` and `install.sh`.

The workflow does not run the test suite, so run it before tagging.

1. On `main`, run the gates: `caffeinate -i bun run test` (0 fail; re-run a failure alone
   with `bun test <file>` per `docs/testing-load.md` → `## How to read a failure`),
   `bun run typecheck` and `bun run format:check`.
2. Bump `package.json` → `version` to the new version.
3. Commit the bump, for example `git commit -am "chore(release): v<version>"`.
4. Tag it: `git tag v<version>`.
5. Push the commit and the tag: `git push origin main`, then `git push origin v<version>`.
6. Watch the `release` workflow on GitHub. A red `check` usually means the tag and
   `package.json` disagree: delete the tag (`git tag -d v<version>`,
   `git push origin :refs/tags/v<version>`), fix, and tag again.
