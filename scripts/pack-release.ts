// `bun scripts/pack-release.ts --out <dir> --dist <built dashboard dist dir>
// [--version <x.y.z>] [--released-at <iso>]`: pack the platform-neutral release
// tarball, its `.sha256` and `release.json` into <dir>.

import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { parseArgs, stringFlag } from "../src/cli/args.ts";
import { dashboardCurrent } from "../src/cli/setup.ts";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const TARBALL = "crank-mem.tar.gz";
const SHIPPED = ["bin", "src", "package.json", "bun.lock", "README.md"];

function fail(message: string): never {
  process.stderr.write(`pack-release: ${message}\n`);
  process.exit(1);
}

function run(cmd: string, args: string[], opts: { cwd: string; env?: NodeJS.ProcessEnv }): string {
  const r = spawnSync(cmd, args, { ...opts, encoding: "utf-8" });
  if (r.status !== 0) fail(`${cmd} ${args.join(" ")} failed: ${r.stderr || r.error?.message}`);
  return r.stdout;
}

const { flags } = parseArgs(process.argv.slice(2), ["out", "dist", "version", "released-at"]);
const out = stringFlag(flags.out);
const dist = stringFlag(flags.dist);
const versionFlag = stringFlag(flags.version);
const releasedAt = stringFlag(flags["released-at"]);
if (!out || !dist || versionFlag === null || releasedAt === null) {
  fail(
    "usage: pack-release.ts --out <dir> --dist <dashboard dist dir> [--version <x.y.z>] [--released-at <iso>]",
  );
}

type Pkg = { version: string };
const repoPkg = JSON.parse(fs.readFileSync(path.join(REPO, "package.json"), "utf-8")) as Pkg;
const version = versionFlag ?? repoPkg.version;
if (!dashboardCurrent(dist, version)) {
  fail(
    `${dist} is not a dashboard build stamped ${version}: it needs index.html and a .crank-version of ${version}`,
  );
}

const stage = fs.mkdtempSync(path.join(os.tmpdir(), "crank-pack-"));
try {
  const lsFiles = ["ls-files", "-z", "--cached", "--others", "--exclude-standard", "--"];
  const listed = run("git", [...lsFiles, ...SHIPPED], { cwd: REPO });
  for (const file of listed.split("\0").filter((f) => f !== "")) {
    fs.mkdirSync(path.dirname(path.join(stage, file)), { recursive: true });
    fs.copyFileSync(path.join(REPO, file), path.join(stage, file));
  }
  const stagedPkg = path.join(stage, "package.json");
  if (versionFlag !== undefined) {
    const pkg = JSON.parse(fs.readFileSync(stagedPkg, "utf-8")) as Pkg;
    pkg.version = versionFlag;
    fs.writeFileSync(stagedPkg, `${JSON.stringify(pkg, null, 2)}\n`);
  }
  fs.cpSync(path.resolve(dist), path.join(stage, "dashboard/dist"), { recursive: true });

  const outDir = path.resolve(out);
  fs.mkdirSync(outDir, { recursive: true });
  run("tar", ["-czf", path.join(outDir, TARBALL), "-C", stage, "."], {
    cwd: stage,
    env: { ...process.env, COPYFILE_DISABLE: "1" },
  });
  const sum = crypto
    .createHash("sha256")
    .update(fs.readFileSync(path.join(outDir, TARBALL)))
    .digest("hex");
  fs.writeFileSync(path.join(outDir, `${TARBALL}.sha256`), `${sum}  ${TARBALL}\n`);
  const release = {
    version,
    tag: `v${version}`,
    releasedAt: releasedAt ?? new Date().toISOString(),
  };
  fs.writeFileSync(path.join(outDir, "release.json"), `${JSON.stringify(release, null, 2)}\n`);
} finally {
  fs.rmSync(stage, { recursive: true, force: true });
}
