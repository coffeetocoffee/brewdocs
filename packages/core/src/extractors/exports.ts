import * as fs from "node:fs";
import * as path from "node:path";
import ts from "typescript";
import type { SymbolDoc } from "../types.js";
import { parseJsDoc } from "./jsdoc.js";
import {
  extractMembers,
  resolvedParamType,
  resolvedReturnType,
  typeParamsOf,
} from "./type-resolve.js";

/** Entry candidates for one `exports` condition value (string or condition map). */
function entryCandidates(val: unknown): string[] {
  if (typeof val === "string") return [val];
  if (val && typeof val === "object") {
    const o = val as Record<string, unknown>;
    // Declaration files carry the richest doc data (explicit types, no
    // inference blow-up on bundled JS), so prefer the `types` condition.
    return ["types", "import", "require", "default"]
      .map((k) => o[k])
      .filter((v): v is string => typeof v === "string");
  }
  return [];
}

/**
 * Every entry point the package exposes: `.` first (original behavior), then
 * subpath exports (`./server`, `./client`, …), then main/module/defaults.
 * Subpath modules are public API too — a package that documents only its
 * root entry misses everything exported behind `exports` keys.
 */
function resolveEntries(root: string, pkg: Record<string, unknown>): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const add = (cands: string[]): void => {
    for (const c of cands) {
      const abs = path.resolve(root, c);
      if (fs.existsSync(abs)) {
        if (!seen.has(abs)) {
          seen.add(abs);
          out.push(abs);
        }
        return;
      }
    }
  };

  const exp = pkg.exports;
  if (exp && typeof exp === "object") {
    const keys = Object.keys(exp as Record<string, unknown>).sort((a, b) =>
      a === "." ? -1 : b === "." ? 1 : a.localeCompare(b),
    );
    for (const k of keys) add(entryCandidates((exp as Record<string, unknown>)[k]));
  }
  add(
    [
      typeof pkg.main === "string" ? pkg.main : undefined,
      typeof pkg.module === "string" ? pkg.module : undefined,
      "index.ts",
      "index.tsx",
      "index.js",
      "index.mjs",
      "src/index.ts",
      "src/index.js",
    ].filter((c): c is string => typeof c === "string"),
  );
  return out;
}

function kindOf(decl: ts.Declaration): SymbolDoc["kind"] {
  if (ts.isFunctionDeclaration(decl) || ts.isFunctionExpression(decl) || ts.isArrowFunction(decl))
    return "function";
  if (ts.isClassDeclaration(decl)) return "class";
  if (ts.isInterfaceDeclaration(decl)) return "interface";
  if (ts.isTypeAliasDeclaration(decl)) return "type";
  if (ts.isEnumDeclaration(decl)) return "enum";
  // `namespace Foo {}` and `declare module "x"` are both ModuleDeclaration;
  // both document as a namespace. Enum members and namespace members are
  // handled in type-resolve/extractMembers.
  if (ts.isModuleDeclaration(decl)) return "namespace";
  if (ts.isVariableDeclaration(decl)) return "constant";
  return "unknown";
}

/**
 * Decorator names for class/function/property declarations. Call decorators
 * collapse to `Name(...)` — full argument text can be arbitrarily large and
 * does not belong on a symbol page.
 */
function decoratorsOf(decl: ts.Declaration): string[] | undefined {
  if (!ts.canHaveDecorators(decl)) return undefined;
  const decs = ts.getDecorators(decl);
  if (!decs || decs.length === 0) return undefined;
  return decs.map((d) => {
    const e = d.expression;
    return ts.isCallExpression(e) ? `${e.expression.getText()}(...)` : e.getText();
  });
}

function declarationOf(symbol: ts.Symbol, checker: ts.TypeChecker): ts.Declaration | undefined {
  let sym = symbol;
  if (sym.flags & ts.SymbolFlags.Alias) {
    // Re-exports (`export * from`, `export { x } from`) point at the export
    // clause; follow them to the real declaration for docs. Can throw for
    // ambient types, so guard it.
    try {
      sym = checker.getAliasedSymbol(sym);
    } catch {
      /* keep original */
    }
  }
  return sym.declarations?.[0];
}

/**
 * JSDoc for `export const X = ...` sits on the enclosing VariableStatement,
 * not the VariableDeclaration the checker hands us — read the comment from
 * the statement when it carries one, so constants are not falsely flagged
 * undocumented by doctor/draft.
 */
function docNodeOf(decl: ts.Declaration): ts.Node {
  if (ts.isVariableDeclaration(decl)) {
    const stmt = decl.parent?.parent;
    if (stmt && ts.isVariableStatement(stmt)) {
      const jsDoc = (stmt as unknown as { jsDoc?: ts.JSDoc[] }).jsDoc;
      if (jsDoc && jsDoc.length > 0) return stmt;
    }
  }
  return decl;
}

/**
 * Build one SymbolDoc from a declaration, enriching JSDoc with real AST
 * types (JSDoc often omits types, which live on the declaration instead).
 * `docNode` is where the JSDoc comment is attached — the declaration itself,
 * or the enclosing statement for `module.exports = function () {}`.
 */
function symbolFromDecl(
  name: string,
  decl: ts.Declaration,
  docNode: ts.Node,
  checker: ts.TypeChecker,
  root: string,
): SymbolDoc {
  const declSourceFile = decl.getSourceFile();
  const kind = kindOf(decl);
  const signature =
    decl.getText(declSourceFile).split("\n").slice(0, 6).join("\n").trim() || undefined;
  const jsdoc = parseJsDoc(docNode);

  if (ts.isFunctionLike(decl)) {
    jsdoc.params = decl.parameters.map((p, i) => {
      const pname = p.name.getText();
      const ptype = p.type
        ? p.type.getText()
        : checker.typeToString(checker.getTypeAtLocation(p));
      const optional = Boolean(p.questionToken || p.initializer);
      const existing = jsdoc.params.find((x) => x.name === pname) ?? jsdoc.params[i];
      return {
        name: pname,
        type: ptype,
        description: existing?.description ?? "",
        optional: optional || Boolean(existing?.optional),
        default: existing?.default,
      };
    });

    const sigDecl = checker.getSignatureFromDeclaration(decl as ts.SignatureDeclaration);
    if (sigDecl && !jsdoc.returns?.type) {
      const rt = checker.typeToString(sigDecl.getReturnType());
      jsdoc.returns = { type: rt, description: jsdoc.returns?.description ?? "" };
    }
  }

  // Direction A: alias-unwrapped types for semantic diffing, plus members,
  // type parameters, @throws and @see on the symbol page.
  const resolvedParams =
    ts.isFunctionLike(decl) && decl.parameters.length > 0
      ? decl.parameters.map((p) => resolvedParamType(p, checker))
      : undefined;
  const resolvedReturn =
    ts.isFunctionLike(decl) && decl.kind !== ts.SyntaxKind.Constructor
      ? resolvedReturnType(decl as ts.SignatureDeclaration, checker)
      : undefined;

  return {
    name,
    kind,
    signature,
    description: jsdoc.description || undefined,
    params: jsdoc.params,
    returns: jsdoc.returns || undefined,
    examples: jsdoc.examples,
    deprecated: jsdoc.deprecated || undefined,
    sourceFile: path.relative(root, declSourceFile.fileName),
    members: extractMembers(decl, checker),
    typeParams: typeParamsOf(decl),
    decorators: decoratorsOf(decl),
    throws: jsdoc.throws.length > 0 ? jsdoc.throws : undefined,
    see: jsdoc.see.length > 0 ? jsdoc.see : undefined,
    resolvedParams,
    resolvedReturn,
  };
}

/** Unwrap chained assignments (`a = b = void 0`) to spot `= void 0` placeholders. */
function isVoidValue(expr: ts.Expression): boolean {
  let e: ts.Expression = expr;
  while (ts.isBinaryExpression(e) && e.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
    e = e.right;
  }
  return e.kind === ts.SyntaxKind.VoidExpression;
}

/** Map of top-level named declarations, for resolving `exports.foo = foo`. */
function topLevelDecls(sf: ts.SourceFile): Map<string, ts.Declaration> {
  const map = new Map<string, ts.Declaration>();
  for (const st of sf.statements) {
    if (ts.isFunctionDeclaration(st) && st.name) map.set(st.name.getText(), st);
    else if (ts.isClassDeclaration(st) && st.name) map.set(st.name.getText(), st);
    else if (ts.isVariableStatement(st)) {
      for (const d of st.declarationList.declarations) {
        if (ts.isIdentifier(d.name)) map.set(d.name.getText(), d);
      }
    }
  }
  return map;
}

/**
 * CommonJS fallback: TypeScript gives JS files using `module.exports` /
 * `exports.foo =` no module symbol, so the checker path finds nothing.
 * Walk top-level export assignments instead. Handles the shapes real
 * packages ship: `module.exports = function/class/ident/object literal`,
 * `exports.name = ident`, and skips `= void 0` interop placeholders.
 */
function extractCjsExports(
  sourceFile: ts.SourceFile,
  checker: ts.TypeChecker,
  root: string,
  pkg: Record<string, unknown>,
): SymbolDoc[] {
  const decls = topLevelDecls(sourceFile);
  const pkgName = typeof pkg.name === "string" ? pkg.name : undefined;
  const symbols: SymbolDoc[] = [];
  const seen = new Set<string>();

  const add = (name: string, decl: ts.Declaration, docNode: ts.Node): void => {
    if (seen.has(name)) return;
    try {
      symbols.push(symbolFromDecl(name, decl, docNode, checker, root));
      seen.add(name);
    } catch {
      /* skip malformed export */
    }
  };

  /** Resolve an assignment RHS to the declaration that documents it. */
  const resolveRhs = (
    expr: ts.Expression,
    fallbackName: string,
    statement: ts.Node,
  ): { name: string; decl: ts.Declaration; docNode: ts.Node } => {
    if (ts.isFunctionExpression(expr) || ts.isClassExpression(expr)) {
      return {
        name: expr.name?.getText() ?? fallbackName,
        decl: expr,
        docNode: statement, // leading JSDoc sits on the statement
      };
    }
    if (ts.isArrowFunction(expr)) {
      return { name: fallbackName, decl: expr, docNode: statement };
    }
    if (ts.isIdentifier(expr)) {
      const d = decls.get(expr.getText());
      if (d) return { name: fallbackName, decl: d, docNode: d };
    }
    // Bare expressions (calls, member accesses) have no declaration to point
    // at; kindOf() classifies them as "unknown" at runtime.
    return { name: fallbackName, decl: expr as unknown as ts.Declaration, docNode: expr };
  };

  for (const st of sourceFile.statements) {
    if (!ts.isExpressionStatement(st)) continue;
    const expr = st.expression;

    // Object.defineProperty(exports, "name", { get: () => X }) — the shape
    // TS-compiled CJS and babel bundles use for named exports.
    if (
      ts.isCallExpression(expr) &&
      ts.isPropertyAccessExpression(expr.expression) &&
      expr.expression.name.text === "defineProperty" &&
      expr.arguments.length >= 3
    ) {
      const [target, nameArg, descArg] = expr.arguments;
      if (target.getText() !== "exports" || !ts.isStringLiteral(nameArg)) continue;
      if (!ts.isObjectLiteralExpression(descArg)) continue;
      const getter = descArg.properties.find(
        (p): p is ts.PropertyAssignment =>
          ts.isPropertyAssignment(p) && p.name.getText().replace(/^["']|["']$/g, "") === "get",
      );
      if (!getter) continue;
      const fn = getter.initializer;
      if (!ts.isFunctionExpression(fn) && !ts.isArrowFunction(fn)) continue;
      // Prefer the declaration the getter returns (`return X;`) so we pick up
      // its JSDoc; fall back to the getter itself.
      let decl: ts.Declaration = fn;
      if (ts.isBlock(fn.body)) {
        for (const stmt of fn.body.statements) {
          if (ts.isReturnStatement(stmt) && stmt.expression && ts.isIdentifier(stmt.expression)) {
            const d = decls.get(stmt.expression.getText());
            if (d) decl = d;
          }
        }
      }
      add(nameArg.text, decl, decl);
      continue;
    }

    if (!ts.isBinaryExpression(expr)) continue;
    if (expr.operatorToken.kind !== ts.SyntaxKind.EqualsToken) continue;
    if (isVoidValue(expr.right)) continue;

    const lhs = expr.left.getText();

    if (lhs === "module.exports") {
      if (ts.isObjectLiteralExpression(expr.right)) {
        for (const prop of expr.right.properties) {
          if (ts.isPropertyAssignment(prop)) {
            const pname = prop.name.getText().replace(/^["']|["']$/g, "");
            const r = resolveRhs(prop.initializer, pname, prop);
            add(pname, r.decl, r.docNode);
          } else if (ts.isShorthandPropertyAssignment(prop)) {
            const pname = prop.name.getText();
            const d = decls.get(pname);
            if (d) add(pname, d, d);
          }
        }
        continue;
      }
      const r = resolveRhs(expr.right, pkgName ?? "default", st);
      add(r.name, r.decl, r.docNode);
    } else {
      const named = /^exports\.([A-Za-z_$][\w$]*)$/.exec(lhs) ??
        /^exports\["(.+)"\]$/.exec(lhs);
      if (!named) continue;
      const r = resolveRhs(expr.right, named[1], st);
      add(named[1], r.decl, r.docNode);
    }
  }

  return symbols;
}

/** Extract exported symbols from one resolved entry file. */
function extractEntry(
  entry: string,
  root: string,
  pkg: Record<string, unknown>,
): SymbolDoc[] {
  const program = ts.createProgram([entry], {
    target: ts.ScriptTarget.ESNext,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    allowJs: true,
    checkJs: false,
    skipLibCheck: true,
    noEmit: true,
    types: [],
  });

  const checker = program.getTypeChecker();
  const sourceFile = program.getSourceFile(entry);
  if (!sourceFile) return [];

  const symbols: SymbolDoc[] = [];
  const moduleSymbol = checker.getSymbolAtLocation(sourceFile);
  if (moduleSymbol) {
    let exported: ts.Symbol[] = [];
    try {
      exported = checker.getExportsOfModule(moduleSymbol);
    } catch {
      exported = [];
    }

    for (const sym of exported) {
      try {
        const decl = declarationOf(sym, checker);
        if (!decl) continue;
        symbols.push(
          symbolFromDecl(sym.getName(), decl, docNodeOf(decl), checker, root),
        );
      } catch {
        // Skip a single malformed export rather than failing the whole build.
        continue;
      }
    }
  }

  // ESM found nothing — the entry may be CommonJS (`module.exports = ...`).
  return symbols.length > 0 ? symbols : extractCjsExports(sourceFile, checker, root, pkg);
}

/**
 * Extract exported symbols (with JSDoc/TSDoc) from every entry the package
 * exposes. Subpath entries re-exporting the same symbol dedupe by
 * name+kind, so `export { x }` in two subpaths yields one symbol.
 *
 * @param root - package root whose entry points are resolved and parsed.
 * @param pkg - parsed package.json used to resolve entry/subpath exports.
 * @returns the deduped exported symbols with their JSDoc/TSDoc.
 */
export function extractExports(root: string, pkg: Record<string, unknown>): SymbolDoc[] {
  const entries = resolveEntries(root, pkg);
  if (entries.length === 0) return [];

  const symbols: SymbolDoc[] = [];
  const seen = new Set<string>();
  for (const entry of entries) {
    for (const sym of extractEntry(entry, root, pkg)) {
      const key = `${sym.name}::${sym.kind}`;
      if (!seen.has(key)) {
        seen.add(key);
        symbols.push(sym);
      }
    }
  }
  return symbols.sort((a, b) => a.name.localeCompare(b.name));
}
