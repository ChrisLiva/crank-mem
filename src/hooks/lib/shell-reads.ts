// The files a Bash command reads with a plain read tool or `crank-mem outline`/`unfold`, and the
// identifiers its greps search for. A best-effort lexer, not a shell parser: callers filter the
// path candidates through ownedPath and the names through the code graph, so a stray word such as
// a `head -n` count costs nothing.

const READERS = new Set(["cat", "sed", "head", "tail", "awk", "nl"]);
/** Readers whose first non-flag word is a program, not a file. */
const PROGRAM_FIRST = new Set(["sed", "awk"]);
/** `crank-mem` subcommands whose first non-flag word, outside a `--from` value, is the file they read. */
const CODE_READERS = new Set(["outline", "unfold"]);
/** An output redirect alone, such as `>`, `2>>` or `&>`, whose target is the next word. */
const BARE_REDIRECT = /^(\d*|&)>>?$/;
/** An output redirect with its target attached, such as `>out`, `2>/dev/null` or `2>&1`. */
const ATTACHED_REDIRECT = /^(\d*|&)>/;
const GREPS = new Set(["rg", "grep"]);
/** Flags of `rg` and `grep` whose next word is the pattern. */
const PATTERN_FLAGS = new Set(["-e", "--regexp"]);
/**
 * Flags of `rg` and `grep` whose next word is their value, so never the pattern. `-r` is left
 * out: `grep -r <pattern>` takes no value, and it is far more common than `rg -r <replacement>`.
 */
const GREP_VALUE_FLAGS = new Set([
  "-A",
  "-B",
  "-C",
  "-d",
  "-f",
  "-g",
  "-j",
  "-m",
  "-M",
  "-t",
  "-T",
  "--after-context",
  "--before-context",
  "--context",
  "--exclude",
  "--exclude-dir",
  "--file",
  "--glob",
  "--iglob",
  "--include",
  "--max-columns",
  "--max-count",
  "--max-depth",
  "--sort",
  "--sortr",
  "--threads",
  "--type",
  "--type-not",
]);
/** The most names one grep pattern may alternate between and still read as a lookup of those names. */
const MAX_GREP_NAMES = 3;
/**
 * A name of 4 or more characters with an uppercase letter, digit or underscore after its first:
 * `fooBar`, `read_store`, `Sha256`. A lowercase word such as `main` is far more often searched
 * for as text than as a symbol.
 */
const IDENTIFIER_SHAPED = /^[A-Za-z_](?=[A-Za-z0-9_]*[A-Z0-9_])[A-Za-z0-9_]{3,}$/;

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

/** One command of a pipeline or list: its unquoted words, and whether a `|` feeds it. */
interface Segment {
  words: string[];
  piped: boolean;
}

/** Words and segments `segments` has lexed so far; `piped` is whether a `|` feeds the segment being lexed. */
interface Lexer {
  out: Segment[];
  words: string[];
  word: string;
  quote: string | null;
  piped: boolean;
}

function endWord(lx: Lexer): void {
  if (lx.word) lx.words.push(lx.word);
  lx.word = "";
}

/** Ends the segment being lexed; `piped` is whether a `|` feeds the next one. */
function endSegment(lx: Lexer, piped = false): void {
  endWord(lx);
  if (lx.words.length > 0) lx.out.push({ words: lx.words, piped: lx.piped });
  lx.words = [];
  lx.piped = piped;
}

/** Lexes the character at `i` into `lx` and returns the index of the next unread character. */
function lexChar(lx: Lexer, command: string, i: number): number {
  const c = command[i]!;
  if (lx.quote) {
    if (c === lx.quote) lx.quote = null;
    else lx.word += c;
  } else if (c === "'" || c === '"') {
    lx.quote = c;
  } else if ((c === "|" || c === "&") && command[i + 1] === c) {
    endSegment(lx);
    return i + 2;
  } else if (c === ";" || c === "\n" || c === "|") {
    endSegment(lx, c === "|");
  } else if (/\s/.test(c)) {
    endWord(lx);
  } else {
    lx.word += c;
  }
  return i + 1;
}

/** Segments split on `&&`, `||`, `;`, `|` and newlines outside quotes, each as unquoted words. */
function segments(command: string): Segment[] {
  const lx: Lexer = { out: [], words: [], word: "", quote: null, piped: false };
  for (let i = 0; i < command.length;) i = lexChar(lx, command, i);
  endSegment(lx);
  return lx.out;
}

/** The file a `crank-mem outline`/`unfold` reads: its first non-flag word outside a `--from` value. */
function codeReaderPath(args: string[]): string | undefined {
  return args.find((w, i, words) => !w.startsWith("-") && words[i - 1] !== "--from");
}

/** A reader's words with flags, redirects and each redirect's target removed. */
function readerArgs(rest: string[]): string[] {
  const args: string[] = [];
  for (let i = 0; i < rest.length; i++) {
    const w = rest[i]!;
    if (BARE_REDIRECT.test(w) || w === "<<") i++;
    else if (ATTACHED_REDIRECT.test(w) || w === "<" || w.startsWith("<<") || w.startsWith("-"))
      continue;
    else args.push(w);
  }
  return args;
}

/** Candidate paths the read commands in `command` name, in order. */
export function shellReadPaths(command: string): string[] {
  const paths: string[] = [];
  for (const { words } of segments(dropHeredocs(command))) {
    const [name, ...rest] = words;
    if (name === "crank-mem" && CODE_READERS.has(rest[0]!)) {
      const file = codeReaderPath(rest.slice(1));
      if (file !== undefined) paths.push(file);
    } else if (READERS.has(name!)) {
      const args = readerArgs(rest);
      paths.push(...(PROGRAM_FIRST.has(name!) ? args.slice(1) : args));
    }
  }
  return paths;
}

/** The words after `rg`, `grep` or `git grep`, or null for any other command. */
function grepArgs(words: string[]): string[] | null {
  if (GREPS.has(words[0]!)) return words.slice(1);
  return words[0] === "git" && words[1] === "grep" ? words.slice(2) : null;
}

/** The pattern a grep's words name: the first `-e` value, else the first word that is no flag or flag value. */
function grepPattern(args: string[]): string | undefined {
  const flagged = args.findIndex((w) => PATTERN_FLAGS.has(w));
  if (flagged !== -1) return args[flagged + 1];
  for (let i = 0; i < args.length; i++) {
    const w = args[i]!;
    if (GREP_VALUE_FLAGS.has(w)) i++;
    else if (!w.startsWith("-")) return w;
  }
  return undefined;
}

/**
 * The names a pattern alternates between, with word boundaries, anchors and a trailing open paren
 * dropped; null unless it holds 1 to MAX_GREP_NAMES names and every one is identifier-shaped.
 */
function patternNames(pattern: string): string[] | null {
  const names = pattern.split(/\\?\|/).map((alt) =>
    alt
      .replaceAll("\\b", "")
      .replace(/^\^/, "")
      .replace(/\$$/, "")
      .replace(/\\?\($/, ""),
  );
  const lookup = names.length <= MAX_GREP_NAMES && names.every((n) => IDENTIFIER_SHAPED.test(n));
  return lookup ? names : null;
}

/**
 * The identifiers each `rg`, `grep` or `git grep` in `command` searches for, one list per grep in
 * order, for the greps whose pattern holds only identifier-shaped names. A grep that a pipe feeds
 * filters output and searches no code, so it names none.
 */
export function shellGrepNames(command: string): string[][] {
  const found: string[][] = [];
  for (const { words, piped } of segments(dropHeredocs(command))) {
    const args = piped ? null : grepArgs(words);
    const pattern = args ? grepPattern(args) : undefined;
    const names = pattern === undefined ? null : patternNames(pattern);
    if (names) found.push(names);
  }
  return found;
}
