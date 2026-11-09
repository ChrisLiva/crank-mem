import { cliVersion } from "./version.ts";
import { unknownFlag } from "./args.ts";
import { COMMANDS, commandHelp, commandSpec, usage } from "./commands.ts";

type Runner = (args: string[]) => Promise<number>;

const RUNNERS: Record<string, Runner> = {
  init: async (args) => (await import("./init.ts")).run(args),
  scan: async (args) => (await import("./scan.ts")).run(args),
  digest: async (args) => (await import("./digest.ts")).run(args),
  search: async (args) => (await import("./recall.ts")).search(args),
  timeline: async (args) => (await import("./recall.ts")).timeline(args),
  get: async (args) => (await import("./recall.ts")).get(args),
  outline: async (args) => (await import("./code.ts")).outline(args),
  unfold: async (args) => (await import("./code.ts")).unfold(args),
  "restore-memory": async (args) => (await import("./restore-memory.ts")).run(args),
  job: async (args) => (await import("../daemon/digest-job.ts")).run(args),
  daemon: async (args) => (await import("../daemon/daemon.ts")).run(args),
  setup: async (args) => (await import("./setup.ts")).run(args),
  stats: async (args) => (await import("./stats.ts")).run(args),
  dashboard: async (args) => (await import("./dashboard.ts")).run(args),
  upgrade: async (args) => (await import("./upgrade.ts")).run(args),
  uninstall: async (args) => (await import("./uninstall.ts")).run(args),
} satisfies Record<keyof typeof COMMANDS, Runner>;

async function main(): Promise<number> {
  const [cmd, ...rest] = process.argv.slice(2);
  const spec = cmd === undefined ? undefined : commandSpec(cmd);
  if (spec) {
    if (rest.includes("--help") || rest.includes("-h")) {
      console.log(commandHelp(spec));
      return 0;
    }
    const unknown = spec.unknownIsText ? null : unknownFlag(rest, spec.value, spec.bool);
    if (unknown !== null) {
      console.error(`crank-mem: unknown flag --${unknown}\n${spec.usage}`);
      return 1;
    }
    const runner = cmd !== undefined && Object.hasOwn(RUNNERS, cmd) ? RUNNERS[cmd] : undefined;
    if (runner) return runner(rest);
  }
  switch (cmd) {
    case "--version":
    case "-v":
      console.log(cliVersion());
      return 0;
    default:
      console.log(usage());
      return cmd === undefined || cmd === "help" || cmd === "--help" ? 0 : 1;
  }
}

process.exit(await main());
