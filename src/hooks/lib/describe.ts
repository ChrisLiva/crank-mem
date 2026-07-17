import * as fs from "node:fs";
import * as path from "node:path";

// One-line file descriptions for the anatomy index. Simple chain, first hit
// wins: known filename → package.json "description" → markdown heading →
// docblock/docstring → header line comment → first declaration. Reads at
// most HEAD_BYTES; result capped at MAX_DESC_CHARS.

const HEAD_BYTES = 12 * 1024;
export const MAX_DESC_CHARS = 150;

const KNOWN_FILENAMES: Record<string, string> = {
  "package.json": "Package manifest",
  "package-lock.json": "npm lockfile",
  "pnpm-lock.yaml": "pnpm lockfile",
  "bun.lock": "bun lockfile",
  "tsconfig.json": "TypeScript compiler configuration",
  "cargo.toml": "Rust package manifest",
  "go.mod": "Go module definition",
  "pyproject.toml": "Python project configuration",
  "requirements.txt": "Python dependencies",
  "makefile": "Build targets",
  "dockerfile": "Container image definition",
  ".gitignore": "Git ignore patterns",
  ".gitattributes": "Git attributes",
  "license": "License",
  "license.md": "License",
  "license.txt": "License",
};

function cap(s: string): string {
  const oneLine = s.replace(/\s+/g, " ").trim();
  return oneLine.length > MAX_DESC_CHARS ? oneLine.slice(0, MAX_DESC_CHARS - 1) + "…" : oneLine;
}

function readHead(filePath: string): string {
  const fd = fs.openSync(filePath, "r");
  try {
    const buf = Buffer.alloc(HEAD_BYTES);
    const n = fs.readSync(fd, buf, 0, HEAD_BYTES, 0);
    return buf.toString("utf-8", 0, n);
  } finally {
    fs.closeSync(fd);
  }
}

/** First markdown heading, or first non-empty line. */
function fromMarkdown(head: string): string | null {
  const m = head.match(/^#{1,3}\s+(.+)$/m);
  if (m) return m[1]!;
  const firstLine = head.split("\n").find((l) => l.trim().length > 0);
  return firstLine ?? null;
}

/** First JSDoc-style docblock or Python docstring summary line. */
function fromDocblock(head: string): string | null {
  const block = head.match(/\/\*\*([\s\S]{1,600}?)\*\//);
  if (block) {
    const line = block[1]!.split("\n").map((l) => l.replace(/^\s*\*?\s?/, "").trim()).find((l) => l && !l.startsWith("@"));
    if (line) return line;
  }
  const doc = head.match(/(?:'''|""")\s*\n?\s*([^\n'"]{3,200})/);
  if (doc) return doc[1]!;
  return null;
}

/** Leading // or # comment lines at the top of the file. */
function fromHeaderComment(head: string): string | null {
  for (const raw of head.split("\n").slice(0, 10)) {
    const line = raw.trim();
    if (!line) continue;
    const m = line.match(/^(?:\/\/|#)\s*(.+)$/);
    if (m && !m[1]!.startsWith("!") && !/^-\*-|^\s*(shellcheck|eslint|ts-|type:|coding[:=])/i.test(m[1]!)) return m[1]!;
    if (!line.startsWith("#!") && !line.startsWith("//") && !line.startsWith("#")) break;
  }
  return null;
}

/** Fall back to the first exported/top-level declaration name. */
function fromDeclaration(head: string): string | null {
  const m = head.match(/^(?:export\s+)?(?:default\s+)?(?:async\s+)?(function|class|const|interface|type|def|struct|enum|fn|func)\s+\*?\s*([A-Za-z_$][\w$]*)/m);
  if (m) return `Defines ${m[2]}`;
  return null;
}

export function describeFile(filePath: string): string {
  const base = path.basename(filePath).toLowerCase();
  const known = KNOWN_FILENAMES[base];

  let head: string;
  try {
    head = readHead(filePath);
  } catch {
    return known ?? "";
  }

  const ext = path.extname(base);
  if (base === "package.json") {
    // Prefer the manifest's own description over the generic label.
    try {
      const desc = JSON.parse(head).description;
      if (typeof desc === "string" && desc) return cap(desc);
    } catch {}
  }
  if (known) return known;
  if (ext === ".json") {
    try {
      const desc = JSON.parse(head).description;
      if (typeof desc === "string" && desc) return cap(desc);
    } catch {}
  }
  if (ext === ".md" || ext === ".rst" || ext === ".adoc" || ext === ".txt") {
    const d = fromMarkdown(head);
    if (d) return cap(d);
  }
  const d = fromDocblock(head) ?? fromHeaderComment(head) ?? fromDeclaration(head);
  return d ? cap(d) : "";
}
