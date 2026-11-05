import * as path from "node:path";
import { createRequire } from "node:module";
import { oneLine } from "../daemon/digest-prompt.ts";

// The tree-sitter reader behind `crank-mem outline`. web-tree-sitter is reached only by
// dynamic import(), so every other command works without the package; its types come
// through type queries, which have no runtime form.

type TreeSitter = typeof import("web-tree-sitter");
type Language = import("web-tree-sitter").Language;
type Node = import("web-tree-sitter").Node;

export type Grammar =
  | "typescript" | "tsx" | "javascript" | "python" | "go" | "rust" | "cpp"
  | "bash" | "java" | "c-sharp" | "ruby" | "php" | "powershell";
export type SymbolKind =
  | "fn" | "method" | "class" | "struct" | "interface" | "trait"
  | "enum" | "namespace" | "module" | "impl" | "type";
export interface CodeSymbol {
  name: string; qualified: string; kind: SymbolKind;
  start: number; end: number; docStart: number;
  indent: string; head: string; fold: "brace" | "other" | "none";
  children: CodeSymbol[];
}

const GRAMMARS: Record<string, Grammar> = {
  ".ts": "typescript", ".mts": "typescript", ".cts": "typescript",
  ".tsx": "tsx",
  ".js": "javascript", ".jsx": "javascript", ".mjs": "javascript", ".cjs": "javascript",
  ".py": "python", ".pyi": "python",
  ".go": "go",
  ".rs": "rust",
  ".c": "cpp", ".h": "cpp", ".cc": "cpp", ".cpp": "cpp", ".cxx": "cpp", ".hpp": "cpp", ".hh": "cpp", ".hxx": "cpp",
  ".sh": "bash", ".bash": "bash",
  ".java": "java",
  ".cs": "c-sharp",
  ".rb": "ruby",
  ".php": "php",
  ".ps1": "powershell", ".psm1": "powershell",
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
    const wasm = createRequire(import.meta.url).resolve(`@vscode/tree-sitter-wasm/wasm/tree-sitter-${grammar}.wasm`);
    language = await ts.Language.load(wasm);
  } catch {
    return null;
  }
  const parser = new ts.Parser();
  parser.setLanguage(language);
  const tree = parser.parse(text);
  if (tree === null) throw new Error("tree-sitter returned no tree");
  const rules = RULES[grammar];
  return rules ? walk(tree.rootNode.namedChildren, null, rules, text) : [];
}

/** One family's Symbol table row; the walk, range, head and fold below read only these. */
interface FamilyRules {
  /** The symbol's kind, or null for a node that is not a symbol; `parent` is the enclosing container's kind. */
  kind(node: Node, parent: SymbolKind | null): SymbolKind | null;
  container(node: Node, kind: SymbolKind): boolean;
  /** The children the walk visits in place of a pass-through node, or null for any other node. */
  passThrough(node: Node): Node[] | null;
  /** `start`: the node whose first line is the symbol's first line; `head`: the node the head text starts at. */
  widen(node: Node): { start: Node; head: Node };
  name(node: Node): string;
  /** The segment members qualify under. */
  scope(node: Node): string;
  /** The node whose start ends the head, or null when bodiless. */
  body(node: Node): Node | null;
  comments: ReadonlySet<string>;
}

const TS_KINDS: Record<string, SymbolKind> = {
  function_declaration: "fn",
  generator_function_declaration: "fn",
  function_signature: "fn",
  class_declaration: "class",
  abstract_class_declaration: "class",
  method_definition: "method",
  abstract_method_signature: "method",
  method_signature: "method",
  interface_declaration: "interface",
  type_alias_declaration: "type",
  enum_declaration: "enum",
  internal_module: "namespace",
  module: "module",
};
const TS_CONTAINERS: ReadonlySet<SymbolKind> = new Set(["class", "interface", "namespace", "module"]);
const TS_PASS_THROUGH = new Set(["export_statement", "ambient_declaration", "lexical_declaration", "variable_declaration"]);
const TS_DECLARATIONS = new Set(["lexical_declaration", "variable_declaration"]);
const FUNCTION_VALUES = new Set(["arrow_function", "function_expression"]);
const hasFunctionValue = (node: Node) => FUNCTION_VALUES.has(node.childForFieldName("value")?.type ?? "");
/** `export default function () {}` or `export default class {}`: the node is its export's field `value`. */
const isDefaultExport = (node: Node) =>
  node.parent?.type === "export_statement" && node.parent.childForFieldName("value")?.equals(node) === true;

const typescript: FamilyRules = {
  kind(node) {
    if (Object.hasOwn(TS_KINDS, node.type)) return TS_KINDS[node.type]!;
    if (node.type === "variable_declarator" && hasFunctionValue(node)) return "fn";
    if (node.type === "public_field_definition" && hasFunctionValue(node)) return "method";
    if (isDefaultExport(node)) return node.type === "function_expression" ? "fn" : node.type === "class" ? "class" : null;
    return null;
  },
  container: (_node, kind) => TS_CONTAINERS.has(kind),
  passThrough(node) {
    if (TS_PASS_THROUGH.has(node.type)) return node.namedChildren;
    return node.type === "expression_statement" ? node.namedChildren.filter((child) => child.type === "internal_module") : null;
  },
  widen(node) {
    let head = node;
    if (head.type === "variable_declarator" && TS_DECLARATIONS.has(head.parent?.type ?? "")) head = head.parent!;
    if (head.parent?.type === "export_statement") head = head.parent;
    let start = head;
    while (start.previousSibling?.type === "decorator") start = start.previousSibling;
    return { start, head };
  },
  name(node) {
    if (isDefaultExport(node)) return "default";
    const name = node.childForFieldName("name");
    if (node.type === "module" && name?.type === "string") return name.namedChildren.find((c) => c.type === "string_fragment")?.text ?? "";
    return name?.text ?? "";
  },
  scope: (node) => typescript.name(node),
  body: (node) => node.type === "variable_declarator" || node.type === "public_field_definition"
    ? node.childForFieldName("value")?.childForFieldName("body") ?? null
    : node.childForFieldName("body"),
  comments: new Set(["comment"]),
};

const RULES: Partial<Record<Grammar, FamilyRules>> = { typescript, tsx: typescript };

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
    while (from.parent && rules.passThrough(from.parent) !== null && from.parent.startPosition.row === start.startPosition.row) from = from.parent;
  }
  let first = start.startPosition.row + 1;
  for (let sib = from.previousSibling; sib && rules.comments.has(sib.type) && endLine(sib) === first - 1; sib = sib.previousSibling) {
    first = sib.startPosition.row + 1;
  }
  return first;
}

/** Criterion 21's head: whitespace collapsed, no space inside brackets, trimmed, one trailing `{` dropped. */
function headText(raw: string): string {
  const text = oneLine(raw).replace(/([([]) /g, "$1").replace(/,? ([)\]])/g, "$1").trim();
  return (text.endsWith("{") ? text.slice(0, -1) : text).trim();
}

function walk(nodes: Node[], parent: { kind: SymbolKind; qualifier: string } | null, rules: FamilyRules, text: string): CodeSymbol[] {
  const symbols: CodeSymbol[] = [];
  for (const node of nodes) {
    const kind = rules.kind(node, parent?.kind ?? null);
    if (kind === null) {
      const inner = rules.passThrough(node);
      if (inner) symbols.push(...walk(inner, parent, rules, text));
      continue;
    }
    const { start, head: headNode } = rules.widen(node);
    const body = rules.body(node);
    const name = rules.name(node);
    const qualifier = parent ? `${parent.qualifier}.${rules.scope(node)}` : rules.scope(node);
    const lineStart = text.lastIndexOf("\n", headNode.startIndex - 1) + 1;
    const startLine = start.startPosition.row + 1;
    symbols.push({
      name,
      qualified: parent ? `${parent.qualifier}.${name}` : name,
      kind,
      start: startLine,
      end: endLine(headNode),
      docStart: docStart(node, start, headNode, rules),
      indent: /^[ \t]*/.exec(text.slice(lineStart, headNode.startIndex))![0],
      head: headText(text.slice(headNode.startIndex, body ? body.startIndex : headNode.endIndex)),
      fold: body === null ? "none" : text.startsWith("{", body.startIndex) ? "brace" : "other",
      children: body && rules.container(node, kind) ? walk(body.namedChildren, { kind, qualifier }, rules, text) : [],
    });
  }
  return symbols;
}
