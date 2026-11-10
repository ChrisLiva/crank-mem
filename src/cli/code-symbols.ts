import * as path from "node:path";
import { createRequire } from "node:module";
import { oneLine } from "../daemon/digest-prompt.ts";

// The tree-sitter reader behind `crank-mem outline` and `unfold`. web-tree-sitter is reached only by
// dynamic import(), so every other command works without the package; its types come
// through type queries, which have no runtime form.

type TreeSitter = typeof import("web-tree-sitter");
type Language = import("web-tree-sitter").Language;
type Node = import("web-tree-sitter").Node;

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
interface FamilyRules {
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
const TS_CONTAINERS: ReadonlySet<SymbolKind> = new Set([
  "class",
  "interface",
  "namespace",
  "module",
]);
const TS_PASS_THROUGH = new Set([
  "export_statement",
  "ambient_declaration",
  "lexical_declaration",
  "variable_declaration",
]);
const TS_DECLARATIONS = new Set(["lexical_declaration", "variable_declaration"]);
const FUNCTION_VALUES = new Set(["arrow_function", "function_expression"]);
/** Symbols whose body is their field `value`'s field `body`. */
const VALUE_BODIES = new Set([
  "variable_declarator",
  "public_field_definition",
  "field_definition",
]);
const hasFunctionValue = (node: Node) =>
  FUNCTION_VALUES.has(node.childForFieldName("value")?.type ?? "");
/** `export default function () {}` or `export default class {}`: the node is its export's field `value`. */
const isDefaultExport = (node: Node) =>
  node.parent?.type === "export_statement" &&
  node.parent.childForFieldName("value")?.equals(node) === true;

const typescript: FamilyRules = {
  kind(node) {
    if (Object.hasOwn(TS_KINDS, node.type)) return TS_KINDS[node.type]!;
    if (node.type === "variable_declarator" && hasFunctionValue(node)) return "fn";
    if (node.type === "public_field_definition" && hasFunctionValue(node)) return "method";
    if (isDefaultExport(node))
      return node.type === "function_expression" ? "fn" : node.type === "class" ? "class" : null;
    return null;
  },
  container: (kind) => TS_CONTAINERS.has(kind),
  passThrough(node) {
    if (TS_PASS_THROUGH.has(node.type)) return node.namedChildren;
    return node.type === "expression_statement"
      ? node.namedChildren.filter((child) => child.type === "internal_module")
      : null;
  },
  widen(node) {
    let head = node;
    if (head.type === "variable_declarator" && TS_DECLARATIONS.has(head.parent?.type ?? ""))
      head = head.parent!;
    if (head.parent?.type === "export_statement") head = head.parent;
    let start = head;
    while (start.previousSibling?.type === "decorator") start = start.previousSibling;
    return { start, head };
  },
  name(node) {
    if (isDefaultExport(node)) return "default";
    const name = node.childForFieldName("name");
    if (node.type === "module" && name?.type === "string")
      return name.namedChildren.find((c) => c.type === "string_fragment")?.text ?? "";
    return name?.text ?? "";
  },
  body: (node) =>
    VALUE_BODIES.has(node.type)
      ? (node.childForFieldName("value")?.childForFieldName("body") ?? null)
      : node.childForFieldName("body"),
};

const javascript: FamilyRules = {
  ...typescript,
  kind(node, parent) {
    if (node.type === "method_definition")
      return node.parent?.type === "class_body" ? "method" : null;
    if (node.type === "field_definition" && hasFunctionValue(node)) return "method";
    return typescript.kind(node, parent);
  },
  passThrough: (node) =>
    TS_DECLARATIONS.has(node.type) || node.type === "export_statement" ? node.namedChildren : null,
  name(node) {
    if (isDefaultExport(node)) return "default";
    return (
      node.childForFieldName(node.type === "field_definition" ? "property" : "name")?.text ?? ""
    );
  },
};

const python: FamilyRules = {
  kind(node, parent) {
    switch (node.type) {
      case "function_definition":
        return parent === "class" ? "method" : "fn";
      case "class_definition":
        return "class";
      case "type_alias_statement":
        return "type";
    }
    return null;
  },
  container: (kind) => kind === "class",
  passThrough(node) {
    const definition =
      node.type === "decorated_definition" ? node.childForFieldName("definition") : null;
    return definition ? [definition] : null;
  },
  widen: (node) => ({
    start: node.parent?.type === "decorated_definition" ? node.parent : node,
    head: node,
  }),
  name: (node) =>
    node.childForFieldName(node.type === "type_alias_statement" ? "left" : "name")?.text ?? "",
};

const GO_SPEC_KINDS: Record<string, SymbolKind> = {
  struct_type: "struct",
  interface_type: "interface",
};
/** A `type_spec` or `type_alias` alone in its `type_declaration`, not grouped in `type ( … )`. */
const isLoneGoSpec = (node: Node) =>
  node.parent?.type === "type_declaration" &&
  !node.parent.children.some((child) => child.type === "(");

const go: FamilyRules = {
  kind(node) {
    switch (node.type) {
      case "function_declaration":
        return "fn";
      case "method_declaration":
        return "method";
      case "type_spec":
        return GO_SPEC_KINDS[node.childForFieldName("type")?.type ?? ""] ?? "type";
      case "type_alias":
        return "type";
    }
    return null;
  },
  container: () => false,
  passThrough: (node) => (node.type === "type_declaration" ? node.namedChildren : null),
  widen(node) {
    const head = isLoneGoSpec(node) ? node.parent! : node;
    return { start: head, head };
  },
  name(node) {
    const name = node.childForFieldName("name")?.text ?? "";
    if (node.type !== "method_declaration") return name;
    const receiver = node
      .childForFieldName("receiver")
      ?.namedChildren.find((c) => c.type === "parameter_declaration");
    const type = receiver?.childForFieldName("type")?.text ?? "";
    return `${type.replace(/^\*\s*/, "").replace(/\[[\s\S]*$/, "")}.${name}`;
  },
  body(node) {
    if (node.type !== "type_spec") return node.childForFieldName("body");
    const type = node.childForFieldName("type");
    if (type?.type === "struct_type")
      return type.namedChildren.find((c) => c.type === "field_declaration_list") ?? null;
    if (type?.type === "interface_type") return type.children.find((c) => c.type === "{") ?? null;
    return null;
  },
};

const CPP_TYPES: Record<string, SymbolKind> = {
  class_specifier: "class",
  struct_specifier: "struct",
  union_specifier: "struct",
  enum_specifier: "enum",
};
const CPP_CONTAINERS: ReadonlySet<SymbolKind> = new Set(["class", "struct", "namespace"]);
const CPP_PASS_THROUGH = new Set([
  "template_declaration",
  "linkage_specification",
  "declaration_list",
  "preproc_if",
  "preproc_ifdef",
  "preproc_elif",
  "preproc_elifdef",
  "preproc_else",
]);
const CPP_FUNCTION_NAMES = new Set([
  "identifier",
  "field_identifier",
  "qualified_identifier",
  "destructor_name",
  "operator_name",
  "operator_cast",
]);
const isAnonymousNamespace = (node: Node) =>
  node.type === "namespace_definition" && node.childForFieldName("name") === null;

/**
 * The function name of a definition or declaration: its field `declarator`, unwrapped through
 * pointer and reference declarators, is a `function_declarator` naming it, or (a definition only)
 * a conversion operator's `operator_cast`. Null when it declares no function.
 */
function cppFunctionName(node: Node): string | null {
  let declarator = node.childForFieldName("declarator");
  while (declarator?.type === "pointer_declarator" || declarator?.type === "reference_declarator") {
    declarator =
      declarator.type === "pointer_declarator"
        ? declarator.childForFieldName("declarator")
        : (declarator.namedChildren[0] ?? null);
  }
  if (declarator?.type === "operator_cast" && node.type === "function_definition")
    return declarator.text;
  if (declarator?.type !== "function_declarator") return null;
  const name = declarator.childForFieldName("declarator");
  return name && CPP_FUNCTION_NAMES.has(name.type) ? name.text : null;
}

const cpp: FamilyRules = {
  kind(node, parent) {
    const fn = parent === "class" || parent === "struct" ? "method" : "fn";
    switch (node.type) {
      case "function_definition":
        return fn;
      case "declaration":
      case "field_declaration":
        return cppFunctionName(node) === null ? null : fn;
      case "namespace_definition":
        return isAnonymousNamespace(node) ? null : "namespace";
      case "alias_declaration":
      case "type_definition":
        return "type";
    }
    if (!Object.hasOwn(CPP_TYPES, node.type)) return null;
    return node.childForFieldName("name") && node.childForFieldName("body")
      ? CPP_TYPES[node.type]!
      : null;
  },
  container: (kind) => CPP_CONTAINERS.has(kind),
  passThrough: (node) =>
    CPP_PASS_THROUGH.has(node.type) || isAnonymousNamespace(node) ? node.namedChildren : null,
  widen(node) {
    const head = node.parent?.type === "template_declaration" ? node.parent : node;
    return { start: head, head };
  },
  name(node) {
    if (
      node.type === "function_definition" ||
      node.type === "declaration" ||
      node.type === "field_declaration"
    ) {
      return cppFunctionName(node) ?? "";
    }
    if (node.type === "type_definition")
      return firstTypeIdentifier(node.childForFieldName("declarator"))?.text ?? "";
    return node.childForFieldName("name")?.text ?? "";
  },
};

function firstTypeIdentifier(node: Node | null): Node | null {
  if (node === null || node.type === "type_identifier") return node;
  for (const child of node.namedChildren) {
    const found = firstTypeIdentifier(child);
    if (found) return found;
  }
  return null;
}

const RUST_KINDS: Record<string, SymbolKind> = {
  struct_item: "struct",
  union_item: "struct",
  enum_item: "enum",
  trait_item: "trait",
  impl_item: "impl",
  type_item: "type",
};
const RUST_CONTAINERS: ReadonlySet<SymbolKind> = new Set(["trait", "impl", "module"]);
/** An impl's type, its base type when generic (`impl<T> Gen<T>` → `Gen`). */
const rustImplType = (node: Node) => {
  const type = node.childForFieldName("type");
  return (type?.type === "generic_type" ? type.childForFieldName("type") : type)?.text ?? "";
};

const rust: FamilyRules & { name(node: Node): string } = {
  kind(node, parent) {
    if (node.type === "function_item" || node.type === "function_signature_item") {
      return parent === "impl" || parent === "trait" ? "method" : "fn";
    }
    if (node.type === "mod_item") return node.childForFieldName("body") ? "module" : null;
    return Object.hasOwn(RUST_KINDS, node.type) ? RUST_KINDS[node.type]! : null;
  },
  container: (kind) => RUST_CONTAINERS.has(kind),
  passThrough: () => null,
  widen(node) {
    let start = node;
    while (start.previousSibling?.type === "attribute_item") start = start.previousSibling;
    return { start, head: node };
  },
  name(node) {
    if (node.type !== "impl_item") return node.childForFieldName("name")?.text ?? "";
    const trait = node.childForFieldName("trait");
    return trait ? `${trait.text} for ${rustImplType(node)}` : rustImplType(node);
  },
  scope: (node) => (node.type === "impl_item" ? rustImplType(node) : rust.name(node)),
  comments: new Set(["line_comment", "block_comment"]),
};

const bash: FamilyRules = {
  kind: (node) => (node.type === "function_definition" ? "fn" : null),
  container: () => false,
  passThrough: () => null,
};

const JAVA_KINDS: Record<string, SymbolKind> = {
  class_declaration: "class",
  record_declaration: "class",
  interface_declaration: "interface",
  annotation_type_declaration: "interface",
  enum_declaration: "enum",
  method_declaration: "method",
  constructor_declaration: "method",
};
const JAVA_CONTAINERS: ReadonlySet<SymbolKind> = new Set(["class", "interface", "enum"]);

const java: FamilyRules = {
  kind: (node) => (Object.hasOwn(JAVA_KINDS, node.type) ? JAVA_KINDS[node.type]! : null),
  container: (kind) => JAVA_CONTAINERS.has(kind),
  passThrough: (node) => (node.type === "enum_body_declarations" ? node.namedChildren : null),
  comments: new Set(["line_comment", "block_comment"]),
};

const CSHARP_KINDS: Record<string, SymbolKind> = {
  namespace_declaration: "namespace",
  file_scoped_namespace_declaration: "namespace",
  class_declaration: "class",
  record_declaration: "class",
  struct_declaration: "struct",
  interface_declaration: "interface",
  enum_declaration: "enum",
  delegate_declaration: "type",
  method_declaration: "method",
  constructor_declaration: "method",
  destructor_declaration: "method",
  operator_declaration: "method",
  indexer_declaration: "method",
};
const CSHARP_CONTAINERS: ReadonlySet<SymbolKind> = new Set([
  "namespace",
  "class",
  "struct",
  "interface",
]);

const csharp: FamilyRules = {
  kind: (node) => (Object.hasOwn(CSHARP_KINDS, node.type) ? CSHARP_KINDS[node.type]! : null),
  container: (kind) => CSHARP_CONTAINERS.has(kind),
  passThrough: (node) => (node.type === "declaration_list" ? node.namedChildren : null),
  name(node) {
    switch (node.type) {
      case "destructor_declaration":
        return `~${node.childForFieldName("name")?.text ?? ""}`;
      case "operator_declaration":
        return `operator ${node.childForFieldName("operator")?.text ?? ""}`;
      case "indexer_declaration":
        return "this[]";
    }
    return node.childForFieldName("name")?.text ?? "";
  },
};

/** A method in `class << self`: its parent is the singleton class's body. */
const inRubySingletonClass = (node: Node) => node.parent?.parent?.type === "singleton_class";
/** `private def pm; end`: the `call` whose argument list holds the method. */
const rubyWrappingCall = (node: Node) =>
  node.parent?.type === "argument_list" && node.parent.parent?.type === "call"
    ? node.parent.parent
    : null;

const ruby: FamilyRules = {
  kind(node, parent) {
    switch (node.type) {
      case "module":
        return "module";
      case "class":
        return "class";
      case "method":
        return parent === null ? "fn" : "method";
      case "singleton_method":
        return "method";
    }
    return null;
  },
  container: (kind) => kind === "module" || kind === "class",
  passThrough(node) {
    if (node.type === "call") {
      const args = node.childForFieldName("arguments")?.namedChildren ?? [];
      return args.filter((child) => child.type === "method" || child.type === "singleton_method");
    }
    return node.type === "singleton_class"
      ? (node.childForFieldName("body")?.namedChildren ?? [])
      : null;
  },
  widen: (node) => ({ start: rubyWrappingCall(node) ?? node, head: node }),
  name(node) {
    const name = node.childForFieldName("name")?.text ?? "";
    if (node.type === "singleton_method")
      return `${node.childForFieldName("object")?.text ?? ""}.${name}`;
    return node.type === "method" && inRubySingletonClass(node) ? `self.${name}` : name;
  },
};

const PHP_KINDS: Record<string, SymbolKind> = {
  function_definition: "fn",
  class_declaration: "class",
  interface_declaration: "interface",
  trait_declaration: "trait",
  enum_declaration: "enum",
  method_declaration: "method",
  namespace_definition: "namespace",
};
const PHP_CONTAINERS: ReadonlySet<SymbolKind> = new Set([
  "class",
  "interface",
  "trait",
  "enum",
  "namespace",
]);

const php: FamilyRules = {
  kind: (node) => (Object.hasOwn(PHP_KINDS, node.type) ? PHP_KINDS[node.type]! : null),
  container: (kind) => PHP_CONTAINERS.has(kind),
  passThrough: () => null,
};

const PS_KINDS: Record<string, SymbolKind> = {
  function_statement: "fn",
  class_statement: "class",
  class_method_definition: "method",
  enum_statement: "enum",
};
/** Statements whose body is their anonymous `{` child, having no body field. */
const PS_BRACE_BODIES = new Set([
  "function_statement",
  "class_statement",
  "class_method_definition",
]);

const powershell: FamilyRules = {
  kind: (node) => (Object.hasOwn(PS_KINDS, node.type) ? PS_KINDS[node.type]! : null),
  container: (kind) => kind === "class",
  passThrough: (node) => (node.type === "statement_list" ? node.namedChildren : null),
  name: (node) =>
    (
      node.children.find((c) => c.type === "function_name") ??
      node.children.find((c) => c.type === "simple_name")
    )?.text ?? "",
  body: (node) =>
    PS_BRACE_BODIES.has(node.type) ? (node.children.find((c) => c.type === "{") ?? null) : null,
  members: (node, body) => node.namedChildren.filter((child) => child.startIndex >= body.endIndex),
};

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
    const { start, head: headNode } = rules.widen?.(node) ?? { start: node, head: node };
    const body = rules.body ? rules.body(node) : node.childForFieldName("body");
    const name = rules.name ? rules.name(node) : (node.childForFieldName("name")?.text ?? "");
    const scope = rules.scope?.(node) ?? name;
    const qualifier = parent ? `${parent.qualifier}.${scope}` : scope;
    const lineStart = text.lastIndexOf("\n", headNode.startIndex - 1) + 1;
    const startLine = start.startPosition.row + 1;
    symbols.push({
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
          ? walk(
              rules.members?.(node, body) ?? body.namedChildren,
              { kind, qualifier },
              rules,
              text,
            )
          : [],
    });
  }
  return symbols;
}
