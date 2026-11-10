import * as path from "node:path";
import { createRequire } from "node:module";
import { oneLine } from "../daemon/digest-prompt.ts";
import { cpp, csharp, go, java, rust } from "./code-families-compiled.ts";
import {
  bash,
  javascript,
  php,
  powershell,
  python,
  ruby,
  typescript,
} from "./code-families-scripting.ts";

// The tree-sitter reader behind `crank-mem outline` and `unfold`. web-tree-sitter is reached only by
// dynamic import(), so every other command works without the package; its types come
// through type queries, which have no runtime form.

type TreeSitter = typeof import("web-tree-sitter");
type Language = import("web-tree-sitter").Language;
export type Node = import("web-tree-sitter").Node;

export type Grammar =
  | "typescript"
  | "tsx"
  | "javascript"
  | "python"
  | "go"
  | "rust"
  | "cpp"
  | "bash"
  | "java"
  | "c-sharp"
  | "ruby"
  | "php"
  | "powershell";
export type SymbolKind =
  | "fn"
  | "method"
  | "class"
  | "struct"
  | "interface"
  | "trait"
  | "enum"
  | "namespace"
  | "module"
  | "impl"
  | "type";
export interface CodeSymbol {
  qualified: string;
  kind: SymbolKind;
  start: number;
  end: number;
  docStart: number;
  indent: string;
  head: string;
  fold: "brace" | "other" | "none";
  children: CodeSymbol[];
}

const GRAMMARS: Record<string, Grammar> = {
  ".ts": "typescript",
  ".mts": "typescript",
  ".cts": "typescript",
  ".tsx": "tsx",
  ".js": "javascript",
  ".jsx": "javascript",
  ".mjs": "javascript",
  ".cjs": "javascript",
  ".py": "python",
  ".pyi": "python",
  ".go": "go",
  ".rs": "rust",
  ".c": "cpp",
  ".h": "cpp",
  ".cc": "cpp",
  ".cpp": "cpp",
  ".cxx": "cpp",
  ".hpp": "cpp",
  ".hh": "cpp",
  ".hxx": "cpp",
  ".sh": "bash",
  ".bash": "bash",
  ".java": "java",
  ".cs": "c-sharp",
  ".rb": "ruby",
  ".php": "php",
  ".ps1": "powershell",
  ".psm1": "powershell",
};

/** The grammar for a path's extension, case-insensitive, or null. */
export function grammarFor(file: string): Grammar | null {
  const ext = path.extname(path.basename(file)).toLowerCase();
  return Object.hasOwn(GRAMMARS, ext) ? GRAMMARS[ext]! : null;
}

/** Top-level symbols with members nested, or null when web-tree-sitter or the grammar's wasm cannot load. */
export async function codeSymbols(text: string, grammar: Grammar): Promise<CodeSymbol[] | null> {
  let ts: TreeSitter;
  let language: Language;
  try {
    ts = await import("web-tree-sitter");
    await ts.Parser.init();
    const wasm = createRequire(import.meta.url).resolve(
      `@vscode/tree-sitter-wasm/wasm/tree-sitter-${grammar}.wasm`,
    );
    language = await ts.Language.load(wasm);
  } catch {
    return null;
  }
  const parser = new ts.Parser();
  parser.setLanguage(language);
  const tree = parser.parse(text);
  if (tree === null) throw new Error("tree-sitter returned no tree");
  return walk(tree.rootNode.namedChildren, null, RULES[grammar], text);
}

/** One family's Symbol table row; the walk, range, head and fold below read only these. */
export interface FamilyRules {
  /** The symbol's kind, or null for a node that is not a symbol; `parent` is the enclosing container's kind. */
  kind(node: Node, parent: SymbolKind | null): SymbolKind | null;
  container(kind: SymbolKind): boolean;
  /** The children the walk visits in place of a pass-through node, or null for any other node. */
  passThrough(node: Node): Node[] | null;
  /** `start`: the node whose first line is the symbol's first line; `head`: the node the head text starts at; both default to the node. */
  widen?(node: Node): { start: Node; head: Node };
  /** The symbol's name; absent: the node's `name` field text, or empty. */
  name?(node: Node): string;
  /** The segment members qualify under; defaults to `name`. */
  scope?(node: Node): string;
  /** The node whose start ends the head, or null when bodiless; defaults to the field `body`. */
  body?(node: Node): Node | null;
  /** A container's members, when they are not `body`'s named children. */
  members?(node: Node, body: Node): Node[];
  /** Comment node types; defaults to `comment`. */
  comments?: ReadonlySet<string>;
}

const DEFAULT_COMMENTS: ReadonlySet<string> = new Set(["comment"]);

const RULES: Record<Grammar, FamilyRules> = {
  typescript,
  tsx: typescript,
  javascript,
  python,
  go,
  cpp,
  rust,
  bash,
  java,
  "c-sharp": csharp,
  ruby,
  php,
  powershell,
};

/** A node's last line, 1-based: a node that ends at column 0 of a later row ends on the row before. */
function endLine(node: Node): number {
  const end = node.endPosition;
  return end.column === 0 && end.row > node.startPosition.row ? end.row : end.row + 1;
}

/** The first line of the comment run directly above the symbol, or its start line with no run. */
function docStart(node: Node, start: Node, head: Node, rules: FamilyRules): number {
  let from = start;
  if (start.equals(head)) {
    from = node;
    while (
      from.parent &&
      rules.passThrough(from.parent) !== null &&
      from.parent.startPosition.row === start.startPosition.row
    )
      from = from.parent;
  }
  let first = start.startPosition.row + 1;
  let sib = from.previousSibling;
  // A container body's first member: its comment run sits in the container, before the body (Python, Ruby).
  if (sib === null && from.parent?.parent?.childForFieldName("body")?.equals(from.parent))
    sib = from.parent.previousSibling;
  for (
    ;
    sib && (rules.comments ?? DEFAULT_COMMENTS).has(sib.type) && endLine(sib) === first - 1;
    sib = sib.previousSibling
  ) {
    first = sib.startPosition.row + 1;
  }
  return first;
}

/** Where a head before `body` ends: after the last non-comment node before it, so a comment between head and body stays out. */
function headEnd(body: Node, rules: FamilyRules): number {
  let sib = body.previousSibling;
  while (sib && (rules.comments ?? DEFAULT_COMMENTS).has(sib.type)) sib = sib.previousSibling;
  return sib ? sib.endIndex : body.startIndex;
}

/** Criterion 21's head: whitespace collapsed, no space inside brackets, trimmed, one trailing `{` dropped. */
function headText(raw: string): string {
  const text = oneLine(raw)
    .replace(/([([]) /g, "$1")
    .replace(/,? ([)\]])/g, "$1")
    .trim();
  return (text.endsWith("{") ? text.slice(0, -1) : text).trim();
}

function walk(
  nodes: Node[],
  parent: { kind: SymbolKind; qualifier: string } | null,
  rules: FamilyRules,
  text: string,
): CodeSymbol[] {
  const symbols: CodeSymbol[] = [];
  for (const node of nodes) {
    const kind = rules.kind(node, parent?.kind ?? null);
    if (kind === null) {
      const inner = rules.passThrough(node);
      if (inner) symbols.push(...walk(inner, parent, rules, text));
      continue;
    }
    symbols.push(buildSymbol(node, kind, parent, rules, text));
  }
  return symbols;
}

/** A symbol node's family hooks, each resolved to its default when the family leaves it out. */
function resolveHooks(
  node: Node,
  parent: { qualifier: string } | null,
  rules: FamilyRules,
): { start: Node; headNode: Node; body: Node | null; name: string; qualifier: string } {
  const { start, head: headNode } = rules.widen?.(node) ?? { start: node, head: node };
  const body = rules.body ? rules.body(node) : node.childForFieldName("body");
  const name = rules.name ? rules.name(node) : (node.childForFieldName("name")?.text ?? "");
  const scope = rules.scope?.(node) ?? name;
  const qualifier = parent ? `${parent.qualifier}.${scope}` : scope;
  return { start, headNode, body, name, qualifier };
}

/** One `CodeSymbol` for a symbol node, with its members walked as children. */
function buildSymbol(
  node: Node,
  kind: SymbolKind,
  parent: { kind: SymbolKind; qualifier: string } | null,
  rules: FamilyRules,
  text: string,
): CodeSymbol {
  const { start, headNode, body, name, qualifier } = resolveHooks(node, parent, rules);
  const lineStart = text.lastIndexOf("\n", headNode.startIndex - 1) + 1;
  const startLine = start.startPosition.row + 1;
  return {
    qualified: parent ? `${parent.qualifier}.${name}` : name,
    kind,
    start: startLine,
    end: endLine(headNode),
    docStart: docStart(node, start, headNode, rules),
    indent: /^[ \t]*/.exec(text.slice(lineStart, headNode.startIndex))![0],
    head: headText(
      text.slice(headNode.startIndex, body ? headEnd(body, rules) : headNode.endIndex),
    ),
    fold: body === null ? "none" : text.startsWith("{", body.startIndex) ? "brace" : "other",
    children:
      body && rules.container(kind)
        ? walk(rules.members?.(node, body) ?? body.namedChildren, { kind, qualifier }, rules, text)
        : [],
  };
}
