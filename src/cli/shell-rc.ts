import * as fs from "node:fs";
import * as path from "node:path";

// The marked block `self-install` adds to a shell's startup file to put the
// bin dir on PATH, and `self-uninstall` removes.

const RC_START = "# >>> crank-mem >>>";
const RC_END = "# <<< crank-mem <<<";

const RC_FILES = [".zshrc", ".bashrc", ".bash_profile", ".profile", ".config/fish/config.fish"];

/** The startup file of the user's login shell and the line that puts `binDir` on PATH in it. */
export function rcTarget(
  shell: string,
  platform: NodeJS.Platform,
  home: string,
): { file: string; line: (binDir: string) => string } {
  const exportLine = (binDir: string) => `export PATH="${binDir}:$PATH"`;
  switch (path.basename(shell)) {
    case "zsh":
      return { file: path.join(home, ".zshrc"), line: exportLine };
    case "bash":
      return {
        file: path.join(home, platform === "darwin" ? ".bash_profile" : ".bashrc"),
        line: exportLine,
      };
    case "fish":
      return {
        file: path.join(home, ".config/fish/config.fish"),
        line: (binDir) => `fish_add_path ${binDir}`,
      };
    default:
      return { file: path.join(home, ".profile"), line: exportLine };
  }
}

/** The span of the block in `text`, from the `\n` before RC_START through RC_END's line end; null when absent. */
function blockSpan(text: string): { start: number; end: number } | null {
  const begin = text.indexOf(`${RC_START}\n`);
  if (begin === -1) return null;
  const close = text.indexOf(RC_END, begin);
  if (close === -1) return null;
  const start = begin > 0 && text[begin - 1] === "\n" ? begin - 1 : begin;
  let end = close + RC_END.length;
  if (text[end] === "\n") end++;
  return { start, end };
}

function readOrEmpty(file: string): string {
  try {
    return fs.readFileSync(file, "utf-8");
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") return "";
    throw err;
  }
}

/** Appends the block holding `line` to `file`, or replaces the block already there. */
export function addPathBlock(file: string, line: string): void {
  const block = `\n${RC_START}\n${line}\n${RC_END}\n`;
  const text = readOrEmpty(file);
  const span = blockSpan(text);
  const next = span ? text.slice(0, span.start) + block + text.slice(span.end) : text + block;
  if (next === text) return;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, next);
}

/** Strips the block from each startup file under `home` that holds one; returns the files changed. */
export function removePathBlocks(home: string): string[] {
  const changed: string[] = [];
  for (const rel of RC_FILES) {
    const file = path.join(home, rel);
    const text = readOrEmpty(file);
    let next = text;
    for (let span = blockSpan(next); span; span = blockSpan(next)) {
      next = next.slice(0, span.start) + next.slice(span.end);
    }
    if (next === text) continue;
    fs.writeFileSync(file, next);
    changed.push(file);
  }
  return changed;
}
