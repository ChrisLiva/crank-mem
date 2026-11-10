import type { FamilyRules, Node, SymbolKind } from "./code-symbols.ts";

// The compiled-language rows of `code-symbols.ts` → `RULES`: Go, C/C++, Rust, Java and C#.

const GO_SPEC_KINDS: Record<string, SymbolKind> = {
  struct_type: "struct",
  interface_type: "interface",
};
/** A `type_spec` or `type_alias` alone in its `type_declaration`, not grouped in `type ( … )`. */
const isLoneGoSpec = (node: Node) =>
  node.parent?.type === "type_declaration" &&
  !node.parent.children.some((child) => child.type === "(");

export const go: FamilyRules = {
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

export const cpp: FamilyRules = {
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

export const rust: FamilyRules & { name(node: Node): string } = {
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

export const java: FamilyRules = {
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

export const csharp: FamilyRules = {
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
