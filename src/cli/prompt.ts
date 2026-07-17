import * as readline from "node:readline/promises";

// Minimal interactive choice prompt. Non-interactive stdin (or --yes) must be
// handled by callers passing a preset answer instead.

export async function choose(question: string, options: string[], def: string): Promise<string> {
  if (!process.stdin.isTTY) return def;
  const rl = readline.createInterface({ input: process.stdin, output: process.stderr });
  try {
    const answer = (await rl.question(`${question} [${options.join("/")}] (default ${def}): `)).trim();
    return options.includes(answer) ? answer : def;
  } finally {
    rl.close();
  }
}
