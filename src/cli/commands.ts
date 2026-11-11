import { cliVersion } from "./version.ts";

// Every command's flags and usage line. main.ts checks a command's flags
// against its entry before loading it, so `--help` and a mistyped flag never
// reach a command that writes. Each command parses with its own `value` list.
// Flags kept out of `usage` exist for tests and stay unlisted.

export interface CommandSpec {
  /** The line in the command list; absent for the internal daemon and job. */
  summary?: string;
  usage: string;
  /** Flags that take the next argument as their value. */
  value: string[];
  /** Flags that stand alone. */
  bool: string[];
  /** search reads an unknown flag as query text, so `search --max-turns` finds that option. */
  unknownIsText?: true;
  /** Runs only from an installed copy; main.ts refuses it in a clone. */
  installedOnly?: true;
}

export const COMMANDS = {
  init: {
    summary: "Wire hooks into this project and run the first scan",
    usage:
      "Usage: crank-mem init [--yes] [--git commit|ignore|exclude] [--adr <dir>] [--codex merge|skip] [--codex-trust write|skip]",
    value: ["git", "adr", "codex", "codex-trust"],
    bool: ["yes"],
  },
  scan: { summary: "Full index rebuild", usage: "Usage: crank-mem scan", value: [], bool: [] },
  digest: {
    summary: "Turn background digests on or off, or resume them",
    usage: "Usage: crank-mem digest on|off|resume",
    value: [],
    bool: [],
  },
  search: {
    summary: "Search stored memory by meaning or keyword",
    usage:
      "Usage: crank-mem search <query> [--limit n] [--type t] [--since YYYY-MM-DD] [--file path] [--stale]",
    value: ["limit", "type", "since", "file", "model-host"],
    bool: ["stale"],
    unknownIsText: true,
  },
  timeline: {
    summary: "Show the observations around one id",
    usage: "Usage: crank-mem timeline <id> [--depth n]",
    value: ["depth"],
    bool: [],
  },
  get: {
    summary: "Print stored observations in full",
    usage: "Usage: crank-mem get <id...>",
    value: [],
    bool: [],
  },
  outline: {
    summary: "Print a source file's symbols with their bodies folded",
    usage: "Usage: crank-mem outline <file> [--from <line>]",
    value: ["from"],
    bool: [],
  },
  unfold: {
    summary: "Print one symbol's full source",
    usage: "Usage: crank-mem unfold <file> <symbol|line>",
    value: [],
    bool: [],
  },
  "restore-memory": {
    summary: "Put a memory.db snapshot back",
    usage: "Usage: crank-mem restore-memory [<file>]",
    value: [],
    bool: [],
  },
  setup: {
    summary: "Install packages, build the dashboard and download the local search model",
    usage: "Usage: crank-mem setup",
    value: ["model-host", "fetch-timeout-ms"],
    bool: [],
  },
  stats: {
    summary: "Index coverage, memory health and Codex hook status",
    usage: "Usage: crank-mem stats",
    value: [],
    bool: [],
  },
  dashboard: {
    summary: "Serve the memory dashboard on localhost",
    usage: "Usage: crank-mem dashboard [--port <n>] [--no-open]",
    value: ["port", "check-every-ms"],
    bool: ["no-open"],
  },
  upgrade: {
    summary: "Repair this project's install, or every registered project with --all",
    usage: "Usage: crank-mem upgrade [--all]",
    value: [],
    bool: ["all"],
  },
  uninstall: {
    summary: "Remove all wiring, offer backup restore",
    usage: "Usage: crank-mem uninstall [--restore] [--delete-crank|--keep-crank] [--yes]",
    value: [],
    bool: ["restore", "yes", "delete-crank", "keep-crank"],
  },
  "self-install": {
    summary: "Finish installing a downloaded release (install.sh runs it)",
    usage: "Usage: crank-mem self-install [--yes] [--bin-dir <dir>]",
    value: ["bin-dir", "model-host", "fetch-timeout-ms"],
    bool: ["yes"],
    installedOnly: true,
  },
  "self-uninstall": {
    summary: "Remove the installed crank-mem, optionally from every project too",
    usage: "Usage: crank-mem self-uninstall [--yes] [--purge] [--bin-dir <dir>]",
    value: ["bin-dir"],
    bool: ["yes", "purge"],
    installedOnly: true,
  },
  "self-update": {
    summary: "Update the installed crank-mem and repair every project",
    usage:
      "Usage: crank-mem self-update [--to vX.Y.Z] [--check] [--auto on|off] [--check-daily on|off]",
    value: ["to", "auto", "check-daily"],
    bool: ["check"],
    installedOnly: true,
  },
  rollback: {
    summary: "Go back to the previously installed version",
    usage: "Usage: crank-mem rollback",
    value: [],
    bool: [],
    installedOnly: true,
  },
  daemon: {
    usage: "Usage: crank-mem daemon (internal: Stop and SessionEnd start it)",
    value: ["sweep-ms", "idle-ms", "retry-ms", "retry-cap-ms", "run-timeout-ms", "mid-session-ms"],
    bool: ["once"],
  },
  job: {
    usage: "Usage: crank-mem job <stem> (internal: the daemon runs it)",
    value: ["run-timeout-ms", "consolidate-every-ms"],
    bool: [],
  },
} satisfies Record<string, CommandSpec>;

export function commandSpec(name: string): CommandSpec | undefined {
  return Object.hasOwn(COMMANDS, name) ? COMMANDS[name as keyof typeof COMMANDS] : undefined;
}

/** `crank-mem <command> --help`: the usage line, then the summary. */
export function commandHelp(spec: CommandSpec): string {
  return spec.summary ? `${spec.usage}\n\n${spec.summary}.` : spec.usage;
}

/** `crank-mem --help`: every command with a summary. */
export function usage(): string {
  const listed = Object.entries(COMMANDS as Record<string, CommandSpec>).filter(
    ([, spec]) => spec.summary,
  );
  const width = Math.max(...listed.map(([name]) => name.length)) + 2;
  const lines = listed.map(([name, spec]) => `  ${name.padEnd(width)}${spec.summary}`);
  return [
    `crank-mem ${cliVersion()} — project memory for coding agents`,
    "",
    "Usage: crank-mem <command> [flags]",
    "",
    "Commands:",
    ...lines,
    "",
    "Run `crank-mem <command> --help` for its flags.",
    "",
  ].join("\n");
}
