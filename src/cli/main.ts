import { cliVersion } from "./version.ts";

const USAGE = `crank-mem ${cliVersion()} — project memory for coding agents

Usage: crank-mem <command> [flags]

Commands:
  init       Wire hooks into this project and run the first scan
  scan       Full index rebuild
  digest     Turn background digests on or off, or resume them
  search     Search stored memory by keyword
  timeline   Show the observations around one id
  get        Print stored observations in full
  stats      Index coverage, memory health and Codex hook status
  upgrade    Re-vendor hooks and repair their wiring after a git pull
  uninstall  Remove all wiring, offer backup restore
`;

async function main(): Promise<number> {
  const [cmd, ...rest] = process.argv.slice(2);
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
    case "job":
      return (await import("../daemon/digest-job.ts")).run(rest);
    case "daemon":
      return (await import("../daemon/daemon.ts")).run(rest);
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
