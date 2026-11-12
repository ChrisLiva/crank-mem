// `bun scripts/release.ts <patch|minor|major|X.Y.Z> [--yes]` (or `bun run release …`):
// cut a release from the repo in the current directory. It refuses unless `main` is checked
// out, clean and not behind origin, and the new tag is unused; asks before anything changes
// (`--yes` answers); runs the gates; bumps `package.json` → `version`, commits, tags
// `v<version>`, and pushes the commit and the tag together, which runs
// `.github/workflows/release.yml`.

import * as fs from "node:fs";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import { parseArgs } from "../src/cli/args.ts";
import { choose } from "../src/cli/prompt.ts";
import { newer } from "../src/cli/version.ts";

const REMOTE = "origin";
const BRANCH = "main";
const USAGE = "usage: release.ts <patch|minor|major|X.Y.Z> [--yes]";

function fail(message: string): never {
  process.stderr.write(`release: ${message}\n`);
  process.exit(1);
}

function git(args: string[], cwd: string): { ok: boolean; out: string; err: string } {
  const r = spawnSync("git", args, { cwd, encoding: "utf-8" });
  return { ok: r.status === 0, out: (r.stdout ?? "").trim(), err: (r.stderr ?? "").trim() };
}

function mustGit(args: string[], cwd: string): string {
  const r = git(args, cwd);
  if (!r.ok) fail(`git ${args.join(" ")} failed: ${r.err}`);
  return r.out;
}

/** The version `bump` names after `current`, or null when `bump` is neither a part nor X.Y.Z. */
function nextVersion(current: string, bump: string): string | null {
  const [major = 0, minor = 0, patch = 0] = current.split(".").map(Number);
  if (bump === "patch") return `${major}.${minor}.${patch + 1}`;
  if (bump === "minor") return `${major}.${minor + 1}.0`;
  if (bump === "major") return `${major + 1}.0.0`;
  const explicit = bump.replace(/^v/, "");
  return /^\d+\.\d+\.\d+$/.test(explicit) ? explicit : null;
}

/** Runs one `bun run <script>` gate with inherited output, under `caffeinate -i` where it exists. */
function gate(script: string, cwd: string): void {
  const caffeinate = spawnSync("sh", ["-c", "command -v caffeinate"]).status === 0;
  const [cmd, args] = caffeinate
    ? ["caffeinate", ["-i", "bun", "run", script]]
    : ["bun", ["run", script]];
  process.stdout.write(`release: bun run ${script}\n`);
  const r = spawnSync(cmd, args, { cwd, stdio: "inherit" });
  if (r.status !== 0) fail(`bun run ${script} failed; nothing was changed`);
}

const { flags, rest } = parseArgs(process.argv.slice(2), []);
if (rest.length !== 1 || Object.keys(flags).some((f) => f !== "yes")) fail(USAGE);

const top = git(["rev-parse", "--show-toplevel"], process.cwd());
if (!top.ok) fail("not inside a git repository");
const root = top.out;
const pkgFile = path.join(root, "package.json");
const pkgText = fs.readFileSync(pkgFile, "utf-8");
const current = (JSON.parse(pkgText) as { version: string }).version;
const version = nextVersion(current, rest[0]!);
if (version === null) fail(USAGE);
if (!newer(version, current)) fail(`${version} is not newer than ${current}`);
const tag = `v${version}`;

const branch = mustGit(["rev-parse", "--abbrev-ref", "HEAD"], root);
if (branch !== BRANCH) fail(`check out ${BRANCH} first (on ${branch})`);
if (mustGit(["status", "--porcelain", "--untracked-files=no"], root) !== "")
  fail("commit or stash the tracked changes first");
mustGit(["fetch", "--quiet", REMOTE, BRANCH], root);
if (!git(["merge-base", "--is-ancestor", `${REMOTE}/${BRANCH}`, "HEAD"], root).ok)
  fail(`${BRANCH} is behind ${REMOTE}/${BRANCH}; pull first`);
if (git(["rev-parse", "--quiet", "--verify", `refs/tags/${tag}`], root).ok)
  fail(`tag ${tag} already exists locally`);
if (mustGit(["ls-remote", "--tags", REMOTE, `refs/tags/${tag}`], root) !== "")
  fail(`tag ${tag} already exists on ${REMOTE}`);

process.stdout.write(
  `release: ${current} → ${version}: run the gates, commit "chore(release): ${tag}", tag ${tag}, push ${BRANCH} and ${tag} to ${REMOTE}\n`,
);
const answer = flags.yes
  ? "yes"
  : await choose(`Push ${tag} to ${REMOTE}? This publishes a release.`, ["no", "yes"], "no");
if (answer !== "yes") fail("not confirmed; nothing was changed (pass --yes to skip the question)");

gate("typecheck", root);
gate("format:check", root);
gate("lint:health", root);
gate("test", root);

const bumped = pkgText.replace(/("version"\s*:\s*)"[^"]*"/, `$1"${version}"`);
fs.writeFileSync(pkgFile, bumped);
mustGit(["commit", "--quiet", "-m", `chore(release): ${tag}`, "--", "package.json"], root);
mustGit(["tag", tag], root);
const pushed = git(["push", "--atomic", REMOTE, BRANCH, tag], root);
if (!pushed.ok)
  fail(
    `push failed (${pushed.err}); the commit and ${tag} exist only locally. ` +
      `Retry with \`git push --atomic ${REMOTE} ${BRANCH} ${tag}\`, ` +
      `or undo with \`git tag -d ${tag} && git reset --hard HEAD~1\``,
  );
process.stdout.write(`release: pushed ${tag}; the release workflow runs on GitHub now\n`);
