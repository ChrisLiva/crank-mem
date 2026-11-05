import { cliVersion } from "./version.ts";
import { unknownFlag } from "./args.ts";
import { commandHelp, commandSpec, usage } from "./commands.ts";

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
  }
  switch (cmd) {
    case "init":
      return (await import("./init.ts")).run(rest);
    case "scan":
      return (await import("./scan.ts")).run(rest);
    case "digest":
      return (await import("./digest.ts")).run(rest);
    case "search":
      return (await import("./recall.ts")).search(rest);
    case "timeline":
      return (await import("./recall.ts")).timeline(rest);
    case "get":
      return (await import("./recall.ts")).get(rest);
    case "outline":
      return (await import("./code.ts")).outline(rest);
    case "unfold":
      return (await import("./code.ts")).unfold(rest);
    case "restore-memory":
      return (await import("./restore-memory.ts")).run(rest);
    case "job":
      return (await import("../daemon/digest-job.ts")).run(rest);
    case "daemon":
      return (await import("../daemon/daemon.ts")).run(rest);
    case "setup":
      return (await import("./setup.ts")).run(rest);
    case "stats":
      return (await import("./stats.ts")).run(rest);
    case "upgrade":
      return (await import("./upgrade.ts")).run(rest);
    case "uninstall":
      return (await import("./uninstall.ts")).run(rest);
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
