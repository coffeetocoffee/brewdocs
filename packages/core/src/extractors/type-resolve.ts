import ts from "typescript";
import type { MemberDoc, TypeParamDoc } from "../types.js";
import { parseJsDoc } from "./jsdoc.js";

/**
 * Direction A — deeper type resolution. Alias-aware type display, generic
 * type parameter extraction, and class/interface member extraction, all via
 * the TypeScript checker that export extraction already builds.
 */

const ALIAS_UNWRAP_DEPTH = 5;

/**
 * Display a type with trivial aliases unwrapped: `type UserId = string`
 * annotating a param resolves to `string`, so a diff between `UserId` and
 * `string` is not flagged breaking. Generic aliases (`Box<T>`) keep their
 * name — unwrapping would lose the type argument.
 */
export function resolveTypeDisplay(typeNode: ts.TypeNode, checker: ts.TypeChecker): string {
  try {
    let type = checker.getTypeFromTypeNode(typeNode);
    let depth = 0;
    while (type.aliasSymbol && !type.aliasTypeArguments && depth < ALIAS_UNWRAP_DEPTH) {
      const decl = type.aliasSymbol.declarations?.[0];
      if (!decl || !ts.isTypeAliasDeclaration(decl)) break;
      const target = checker.getTypeFromTypeNode(decl.type);
      if (target === type) break;
      type = target;
      depth++;
    }
    return checker.typeToString(type);
  } catch {
    return typeNode.getText();
  }
}

/** Alias-unwrapped type for one parameter, with rest/optional markers kept. */
export function resolvedParamType(p: ts.ParameterDeclaration, checker: ts.TypeChecker): string {
  const rest = p.dotDotDotToken ? "..." : "";
  const type = p.type
    ? resolveTypeDisplay(p.type, checker)
    : checker.typeToString(checker.getTypeAtLocation(p));
  const optional = p.questionToken || p.initializer ? "?" : "";
  return `${rest}${type}${optional}`;
}

/** Alias-unwrapped return type for a function-like declaration. */
export function resolvedReturnType(
  decl: ts.SignatureDeclaration,
  checker: ts.TypeChecker,
): string | undefined {
  try {
    if (decl.type) return resolveTypeDisplay(decl.type, checker);
    const sig = checker.getSignatureFromDeclaration(decl);
    return sig ? checker.typeToString(sig.getReturnType()) : undefined;
  } catch {
    return undefined;
  }
}

/** Extract generic type parameters (`<K extends string, V = number>`) from any declaration that can carry them. */
export function typeParamsOf(decl: ts.Declaration): TypeParamDoc[] | undefined {
  const tps = (decl as { typeParameters?: readonly ts.TypeParameterDeclaration[] })
    .typeParameters;
  if (!tps || tps.length === 0) return undefined;
  return tps.map((tp) => ({
    name: tp.name.getText(),
    constraint: tp.constraint?.getText(),
    default: tp.default?.getText(),
  }));
}

function modifiersOf(node: ts.Node): readonly ts.ModifierLike[] {
  if (ts.canHaveModifiers(node)) return ts.getModifiers(node) ?? [];
  return (node as { modifiers?: readonly ts.ModifierLike[] }).modifiers ?? [];
}

function paramText(p: ts.ParameterDeclaration, checker: ts.TypeChecker): string {
  const rest = p.dotDotDotToken ? "..." : "";
  const optional = p.questionToken || p.initializer ? "?" : "";
  const type = p.type
    ? resolveTypeDisplay(p.type, checker)
    : checker.typeToString(checker.getTypeAtLocation(p));
  return `${rest}${p.name.getText()}${optional}: ${type}`;
}

function paramsText(
  params: readonly ts.ParameterDeclaration[],
  checker: ts.TypeChecker,
): string {
  return params.map((p) => paramText(p, checker)).join(", ");
}

function memberDoc(
  m: ts.ClassElement | ts.TypeElement,
  checker: ts.TypeChecker,
): MemberDoc | undefined {
  const jsdoc = parseJsDoc(m);

  // Constructors carry no name node — handle them before the name guard.
  if (ts.isConstructorDeclaration(m)) {
    return {
      name: "constructor",
      kind: "constructor",
      signature: `constructor(${paramsText(m.parameters, checker)})`,
      description: jsdoc.description || undefined,
    };
  }

  if (!m.name || ts.isComputedPropertyName(m.name)) return undefined;
  const name = m.name.getText();
  const mods = modifiersOf(m);
  const has = (kind: ts.SyntaxKind) => mods.some((x) => x.kind === kind);
  const visibility = has(ts.SyntaxKind.PrivateKeyword)
    ? "private"
    : has(ts.SyntaxKind.ProtectedKeyword)
      ? "protected"
      : undefined;
  const isStatic = has(ts.SyntaxKind.StaticKeyword) || undefined;
  const isReadonly = has(ts.SyntaxKind.ReadonlyKeyword) || undefined;
  const optional = Boolean((m as ts.PropertyDeclaration).questionToken) || undefined;

  const prefix = [
    visibility,
    isStatic ? "static" : "",
    isReadonly ? "readonly" : "",
  ]
    .filter(Boolean)
    .join(" ");
  const withPrefix = (sig: string): string =>
    prefix ? `${prefix} ${sig}` : sig;

  if (ts.isMethodDeclaration(m) || ts.isMethodSignature(m)) {
    const sig = checker.getSignatureFromDeclaration(m);
    const ret = sig
      ? checker.typeToString(sig.getReturnType())
      : ((m as ts.MethodDeclaration).type?.getText() ?? "void");
    return {
      name,
      kind: "method",
      signature: withPrefix(`${name}(${paramsText(m.parameters, checker)}): ${ret}`),
      description: jsdoc.description || undefined,
      optional,
      static: isStatic,
      readonly: isReadonly,
      visibility,
    };
  }

  if (ts.isPropertyDeclaration(m) || ts.isPropertySignature(m)) {
    const type = m.type
      ? resolveTypeDisplay(m.type, checker)
      : checker.typeToString(checker.getTypeAtLocation(m));
    return {
      name,
      kind: "property",
      signature: withPrefix(`${name}${optional ? "?" : ""}: ${type}`),
      description: jsdoc.description || undefined,
      type,
      optional,
      static: isStatic,
      readonly: isReadonly,
      visibility,
    };
  }

  if (ts.isGetAccessorDeclaration(m)) {
    const type = m.type
      ? resolveTypeDisplay(m.type, checker)
      : checker.typeToString(checker.getTypeAtLocation(m));
    return {
      name,
      kind: "property",
      signature: withPrefix(`get ${name}(): ${type}`),
      description: jsdoc.description || undefined,
      type,
      static: isStatic,
      visibility,
    };
  }

  if (ts.isSetAccessorDeclaration(m)) {
    return {
      name,
      kind: "property",
      signature: withPrefix(`set ${name}(${paramsText(m.parameters, checker)})`),
      description: jsdoc.description || undefined,
      static: isStatic,
      visibility,
    };
  }

  return undefined;
}

/**
 * Extract method/property/constructor members from a class or interface
 * declaration. Returns undefined for anything else (or empty shapes), so
 * SymbolDoc stays lean.
 */
export function extractMembers(
  decl: ts.Declaration,
  checker: ts.TypeChecker,
): MemberDoc[] | undefined {
  if (!ts.isClassDeclaration(decl) && !ts.isInterfaceDeclaration(decl)) {
    return undefined;
  }
  const members: MemberDoc[] = [];
  for (const m of decl.members) {
    try {
      const doc = memberDoc(m, checker);
      if (doc) members.push(doc);
    } catch {
      /* skip a malformed member rather than failing the symbol */
    }
  }
  return members.length > 0 ? members : undefined;
}
