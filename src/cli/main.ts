import { cliVersion } from "./version.ts";

const USAGE = `crank-mem ${cliVersion()} — project memory for coding agents

Usage: crank-mem <command> [flags]

Commands:
  init       Wire hooks into this project and run the first scan
  scan       Full index rebuild
  stats      Index report
  upgrade    Re-vendor hooks after a git pull in the clone
  uninstall  Remove all wiring, offer backup restore
`;

async function main(): Promise<number> {
  const [cmd, ...rest] = process.argv.slice(2);
  switch (cmd) {
    case "init":
      return (await import("./init.ts")).run(rest);
    case "scan":
      return (await import("./scan.ts")).run(rest);
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
      console.log(USAGE);
      return cmd === undefined || cmd === "help" || cmd === "--help" ? 0 : 1;
  }
}

process.exit(await main());
