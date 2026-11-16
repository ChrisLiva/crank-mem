import type { CallRules, FamilyRules, Node, Receiver, SymbolKind } from "./code-symbols.ts";

// The compiled-language rows of `code-symbols.ts` → `RULES`: Go, C/C++, Rust, Java and C#.

type Callee = ReturnType<CallRules["callee"]>;
/** A callee, or null when the call names nothing. */
const named = (name: string | null, receiver: Receiver): Callee =>
  name === null ? null : { name, receiver };

const GO_SPEC_KINDS: Record<string, SymbolKind> = {
  struct_type: "struct",
  interface_type: "interface",
};
/** A `type_spec` or `type_alias` alone in its `type_declaration`, not grouped in `type ( … )`. */
const isLoneGoSpec = (node: Node) =>
  node.parent?.type === "type_declaration" &&
  !node.parent.children.some((child) => child.type === "(");

/** A composite literal's type name: `T`, `pkg.T` or `T[int]`. */
function goTypeName(node: Node | null): { name: string; qualified: boolean } | null {
  if (node?.type === "type_identifier") return { name: node.text, qualified: false };
  if (node?.type === "generic_type") return goTypeName(node.childForFieldName("type"));
  const name = node?.type === "qualified_type" ? node.childForFieldName("name") : null;
  return name ? { name: name.text, qualified: true } : null;
}

const goCalls: CallRules = {
  types: new Set(["call_expression", "composite_literal"]),
  callee(node) {
    if (node.type === "composite_literal") {
      const type = goTypeName(node.childForFieldName("type"));
      return type && { name: type.name, receiver: type.qualified ? "member" : "bare" };
    }
    const target = node.childForFieldName("function");
    if (target?.type === "identifier") return { name: target.text, receiver: "bare" };
    const field = target?.type === "selector_expression" ? target.childForFieldName("field") : null;
    if (field === null || target === null) return null;
    const self = target.childForFieldName("operand")?.text === "self";
    return { name: field.text, receiver: self ? "self" : "member" };
  },
};

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
  calls: goCalls,
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

/** The name a call or `new` reaches: an identifier's text, or the last segment of a qualified or template name. */
function cppCallName(node: Node | null): string | null {
  switch (node?.type) {
    case "qualified_identifier":
    case "template_function":
    case "template_method":
    case "template_type":
      return cppCallName(node.childForFieldName("name"));
    case "identifier":
    case "field_identifier":
    case "type_identifier":
    case "destructor_name":
    case "operator_name":
      return node.text;
  }
  return null;
}

const cppCalls: CallRules = {
  types: new Set(["call_expression", "new_expression"]),
  callee(node) {
    const target = node.childForFieldName(node.type === "new_expression" ? "type" : "function");
    if (target?.type === "field_expression") {
      const name = cppCallName(target.childForFieldName("field"));
      const self = target.childForFieldName("argument")?.type === "this";
      return named(name, self ? "self" : "member");
    }
    const receiver = target?.type === "qualified_identifier" ? "member" : "bare";
    return named(cppCallName(target), receiver);
  },
};

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
  calls: cppCalls,
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

/** A call's callee, unwrapped through `(f)` and `f::<T>`. */
function rustTarget(node: Node | null): Node | null {
  while (node?.type === "parenthesized_expression" || node?.type === "generic_function")
    node =
      node.type === "generic_function"
        ? node.childForFieldName("function")
        : (node.namedChildren[0] ?? null);
  return node;
}

/** A call's callee: a path's last segment (`Self::f` is a self call), a method, or a plain name. */
function rustCallee(target: Node | null): Callee {
  if (target?.type === "identifier") return named(target.text, "bare");
  if (target?.type === "scoped_identifier") {
    const self = target.childForFieldName("path")?.text === "Self";
    return named(target.childForFieldName("name")?.text ?? null, self ? "self" : "member");
  }
  const field = target?.type === "field_expression" ? target.childForFieldName("field") : null;
  const self = target?.childForFieldName("value")?.type === "self";
  return field?.type === "field_identifier" ? named(field.text, self ? "self" : "member") : null;
}

const rustCalls: CallRules = {
  types: new Set(["call_expression", "struct_expression"]),
  callee: (node) =>
    node.type === "struct_expression"
      ? named(node.childForFieldName("name")?.text ?? null, "bare")
      : rustCallee(rustTarget(node.childForFieldName("function"))),
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
  calls: rustCalls,
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

/** A created class's name: `T`, `a.T` or `T<X>`. */
function javaTypeName(node: Node | null): { name: string; qualified: boolean } | null {
  if (node?.type === "type_identifier") return { name: node.text, qualified: false };
  if (node?.type === "generic_type") return javaTypeName(node.namedChildren[0] ?? null);
  const name = node?.type === "scoped_type_identifier" ? node.namedChildren.at(-1) : null;
  return name ? { name: name.text, qualified: true } : null;
}

const JAVA_TYPE_DECLARATIONS = new Set([
  "class_declaration",
  "enum_declaration",
  "record_declaration",
]);

/** The class a `this(…)` or `super(…)` constructor call sits in. */
function javaEnclosingType(node: Node): Node | null {
  for (let at = node.parent; at !== null; at = at.parent)
    if (JAVA_TYPE_DECLARATIONS.has(at.type)) return at;
  return null;
}

/** `this(…)` names the enclosing class, `super(…)` its superclass; both reach it as `self`. */
function javaConstructorCallee(node: Node): { name: string; receiver: "self" } | null {
  const own = javaEnclosingType(node);
  const name = node.namedChildren.some((c) => c.type === "this")
    ? own?.childForFieldName("name")?.text
    : javaTypeName(own?.childForFieldName("superclass")?.namedChildren[0] ?? null)?.name;
  return name ? { name, receiver: "self" } : null;
}

const javaCalls: CallRules = {
  types: new Set([
    "method_invocation",
    "object_creation_expression",
    "explicit_constructor_invocation",
  ]),
  callee(node) {
    if (node.type === "explicit_constructor_invocation") return javaConstructorCallee(node);
    if (node.type === "object_creation_expression") {
      const type = javaTypeName(node.childForFieldName("type"));
      return type && { name: type.name, receiver: type.qualified ? "member" : "bare" };
    }
    const name = node.childForFieldName("name");
    const object = node.childForFieldName("object");
    if (name === null) return null;
    if (object === null) return { name: name.text, receiver: "bare" };
    return { name: name.text, receiver: object.type === "this" ? "self" : "member" };
  },
};

export const java: FamilyRules = {
  kind: (node) => (Object.hasOwn(JAVA_KINDS, node.type) ? JAVA_KINDS[node.type]! : null),
  container: (kind) => JAVA_CONTAINERS.has(kind),
  passThrough: (node) => (node.type === "enum_body_declarations" ? node.namedChildren : null),
  comments: new Set(["line_comment", "block_comment"]),
  calls: javaCalls,
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

/** A callee or created type's name: `T`, `T<X>` or the last segment of `a.T`. */
function csharpName(node: Node | null): string | null {
  switch (node?.type) {
    case "identifier":
      return node.text;
    case "generic_name":
      return node.namedChildren[0]?.text ?? null;
    case "qualified_name":
      return csharpName(node.childForFieldName("name"));
  }
  return null;
}

/** `Foo f = new(…)` has the type its declaration names; any other `new(…)` has none. */
function targetTypedName(node: Node): string | null {
  const declaration = node.parent?.type === "variable_declarator" ? node.parent.parent : null;
  return csharpName(declaration?.childForFieldName("type") ?? null);
}

function csharpCreated(node: Node): Callee {
  const type = node.childForFieldName("type");
  const name = type === null ? targetTypedName(node) : csharpName(type);
  return named(name, type?.type === "qualified_name" ? "member" : "bare");
}

function csharpInvoked(node: Node): Callee {
  const target = node.childForFieldName("function");
  if (target?.type === "member_access_expression") {
    const self = target.childForFieldName("expression")?.type === "this";
    return named(csharpName(target.childForFieldName("name")), self ? "self" : "member");
  }
  if (target?.type === "conditional_access_expression") {
    const binding = target.namedChildren.find((c) => c.type === "member_binding_expression");
    return named(csharpName(binding?.childForFieldName("name") ?? null), "member");
  }
  return named(csharpName(target), "bare");
}

const csharpCalls: CallRules = {
  types: new Set([
    "invocation_expression",
    "object_creation_expression",
    "implicit_object_creation_expression",
  ]),
  callee: (node) =>
    node.type === "invocation_expression" ? csharpInvoked(node) : csharpCreated(node),
};

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
  calls: csharpCalls,
};
