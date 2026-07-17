// Interactive single-choice prompt: ↑/↓ + enter on a raw TTY, rendered on
// stderr, zero dependencies. Non-interactive stdin (or --yes) must be handled
// by callers passing a preset answer instead; without a TTY on both stdin and
// stderr we fall back to the default.

export type KeyAction =
  | { type: "move"; index: number }
  | { type: "submit" }
  | { type: "cancel" }
  | { type: "interrupt" }
  | { type: "none" };

/**
 * Pure keypress → action mapping (exported for tests). Tolerates coalesced
 * reads (fast typing/paste deliver several bytes at once) and the pty ICRNL
 * rewrite of \r→\n: enter is any chunk ending in a newline, and arrows match
 * by their escape sequence anywhere in the chunk rather than whole-string.
 */
export function decodeKey(input: string, index: number, count: number): KeyAction {
  if (input.includes("\x03")) return { type: "interrupt" }; // ctrl-c
  if (input === "\x1b" || input.includes("\x04")) return { type: "cancel" }; // esc, ctrl-d → default
  if (input.endsWith("\r") || input.endsWith("\n")) return { type: "submit" };
  if (input.endsWith("\x1b[A") || input === "k") return { type: "move", index: (index + count - 1) % count };
  if (input.endsWith("\x1b[B") || input === "j") return { type: "move", index: (index + 1) % count };
  return { type: "none" };
}

export async function choose(question: string, options: string[], def: string): Promise<string> {
  if (!process.stdin.isTTY || !process.stderr.isTTY) return def;
  const out = process.stderr;
  let index = Math.max(0, options.indexOf(def));

  const renderOptions = (): void => {
    for (let i = 0; i < options.length; i++) {
      const line = i === index ? `\x1b[36m❯ ${options[i]}\x1b[0m` : `  ${options[i]}`;
      out.write(`\x1b[2K${line}\n`);
    }
  };

  out.write(`${question} \x1b[2m(↑/↓, enter)\x1b[0m\n`);
  out.write("\x1b[?25l"); // hide cursor while the menu is live
  renderOptions();

  const selected = await new Promise<string>((resolve) => {
    const stdin = process.stdin;
    const restore = (): void => {
      stdin.setRawMode(false);
      stdin.pause();
      stdin.removeListener("data", onData);
      out.write("\x1b[?25h");
    };
    const onData = (chunk: Buffer): void => {
      const action = decodeKey(chunk.toString("utf-8"), index, options.length);
      if (action.type === "move") {
        index = action.index;
        out.write(`\x1b[${options.length}A`);
        renderOptions();
      } else if (action.type === "submit" || action.type === "cancel") {
        restore();
        resolve(action.type === "submit" ? options[index]! : def);
      } else if (action.type === "interrupt") {
        restore();
        out.write("\n");
        process.exit(130);
      }
    };
    stdin.setRawMode(true);
    stdin.resume();
    stdin.on("data", onData);
  });

  // Collapse the menu into a single answered line.
  out.write(`\x1b[${options.length + 1}A\x1b[J${question} ${selected}\n`);
  return selected;
}
