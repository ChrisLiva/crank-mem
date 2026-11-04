// Tiny flag parser: --key value and boolean --flag.

export function parseArgs(argv: string[], valueFlags: string[]): { flags: Record<string, string | boolean>; rest: string[] } {
  const flags: Record<string, string | boolean> = {};
  const rest: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg.startsWith("--")) {
      const name = arg.slice(2);
      if (valueFlags.includes(name) && i + 1 < argv.length) {
        flags[name] = argv[++i]!;
      } else {
        flags[name] = true;
      }
    } else {
      rest.push(arg);
    }
  }
  return { flags, rest };
}

/** The first flag in argv that is neither one of `valueFlags` nor one of `boolFlags`, or null. */
export function unknownFlag(argv: string[], valueFlags: string[], boolFlags: string[]): string | null {
  const known = [...valueFlags, ...boolFlags];
  return Object.keys(parseArgs(argv, valueFlags).flags).find((name) => !known.includes(name)) ?? null;
}

/** A numeric flag's value, or the default when it is absent, valueless (`true`) or not a positive number. */
export function positive(value: string | boolean | undefined, fallback: number): number {
  const n = typeof value === "string" ? Number(value) : NaN;
  return Number.isFinite(n) && n > 0 ? n : fallback;
}
