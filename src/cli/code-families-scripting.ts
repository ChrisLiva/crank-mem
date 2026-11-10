import type { FamilyRules, Node, SymbolKind } from "./code-symbols.ts";

// The scripting-language rows of `code-symbols.ts` → `RULES`: TypeScript, JavaScript, Python, Bash, Ruby, PHP and PowerShell.

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

export const typescript: FamilyRules = {
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

export const javascript: FamilyRules = {
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

export const python: FamilyRules = {
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

export const bash: FamilyRules = {
  kind: (node) => (node.type === "function_definition" ? "fn" : null),
  container: () => false,
  passThrough: () => null,
};

/** A method in `class << self`: its parent is the singleton class's body. */
const inRubySingletonClass = (node: Node) => node.parent?.parent?.type === "singleton_class";
/** `private def pm; end`: the `call` whose argument list holds the method. */
const rubyWrappingCall = (node: Node) =>
  node.parent?.type === "argument_list" && node.parent.parent?.type === "call"
    ? node.parent.parent
    : null;

export const ruby: FamilyRules = {
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

export const php: FamilyRules = {
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

export const powershell: FamilyRules = {
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
