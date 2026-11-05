// The files a Bash command reads with a plain read tool or `crank-mem outline`/`unfold`. A best-effort
// lexer, not a shell parser: callers filter the candidates through
// memoryPaths, so a stray word such as a `head -n` count costs nothing.

const READERS = new Set(["cat", "sed", "head", "tail", "awk", "nl"]);
/** Readers whose first non-flag word is a program, not a file. */
const PROGRAM_FIRST = new Set(["sed", "awk"]);
/** `crank-mem` subcommands whose first non-flag word, outside a `--from` value, is the file they read. */
const CODE_READERS = new Set(["outline", "unfold"]);
const REDIRECTS = new Set([">", ">>", "2>", "&>"]);

/** The command with each heredoc body, terminator line included, removed. */
function dropHeredocs(command: string): string {
  const kept: string[] = [];
  const pending: string[] = [];
  for (const line of command.split("\n")) {
    if (pending.length > 0) {
      if (line === pending[0]) pending.shift();
      continue;
    }
    kept.push(line);
    for (const m of line.matchAll(/<<-?\s*(['"]?)([\w.-]+)\1/g)) pending.push(m[2]!);
  }
  return kept.join("\n");
}

/** Segments split on `&&`, `||`, `;`, `|` and newlines outside quotes, each as unquoted words. */
function segments(command: string): string[][] {
  const out: string[][] = [];
  let words: string[] = [];
  let word = "";
  let quote: string | null = null;
  const endWord = () => {
    if (word) words.push(word);
    word = "";
  };
  const endSegment = () => {
    endWord();
    if (words.length > 0) out.push(words);
    words = [];
  };
  for (let i = 0; i < command.length; i++) {
    const c = command[i]!;
    if (quote) {
      if (c === quote) quote = null;
      else word += c;
    } else if (c === "'" || c === '"') {
      quote = c;
    } else if (c === ";" || c === "\n" || c === "|") {
      if (c === "|" && command[i + 1] === "|") i++;
      endSegment();
    } else if (c === "&" && command[i + 1] === "&") {
      i++;
      endSegment();
    } else if (/\s/.test(c)) {
      endWord();
    } else {
      word += c;
    }
  }
  endSegment();
  return out;
}

/** Candidate paths the read commands in `command` name, in order. */
export function shellReadPaths(command: string): string[] {
  const paths: string[] = [];
  for (const [name, ...rest] of segments(dropHeredocs(command))) {
    if (name === "crank-mem" && CODE_READERS.has(rest[0]!)) {
      const file = rest.slice(1).find((w, i, words) => !w.startsWith("-") && words[i - 1] !== "--from");
      if (file !== undefined) paths.push(file);
      continue;
    }
    if (!READERS.has(name!)) continue;
    const args: string[] = [];
    for (let i = 0; i < rest.length; i++) {
      const w = rest[i]!;
      if (REDIRECTS.has(w) || w === "<<") i++;
      else if (w.startsWith(">") || w === "<" || w.startsWith("<<") || w.startsWith("-")) continue;
      else args.push(w);
    }
    paths.push(...(PROGRAM_FIRST.has(name!) ? args.slice(1) : args));
  }
  return paths;
}
