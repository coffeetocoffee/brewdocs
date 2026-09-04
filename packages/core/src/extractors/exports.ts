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

function resolveEntry(root: string, pkg: Record<string, unknown>): string | undefined {
  const candidates: string[] = [];

  const exp = pkg.exports;
  if (exp && typeof exp === "object") {
    const dot = (exp as Record<string, unknown>)["."];
    if (typeof dot === "string") candidates.push(dot);
    else if (dot && typeof dot === "object") {
      const o = dot as Record<string, unknown>;
      // Declaration files carry the richest doc data (explicit types, no
      // inference blow-up on bundled JS), so prefer the `types` condition.
      for (const key of ["types", "import", "require", "default"]) {
        const v = o[key];
        if (typeof v === "string") candidates.push(v);
      }
    }
  }
  if (typeof pkg.main === "string") candidates.push(pkg.main);
  if (typeof pkg.module === "string") candidates.push(pkg.module);
  candidates.push(
    "index.ts",
    "index.tsx",
    "index.js",
    "index.mjs",
    "src/index.ts",
    "src/index.js",
  );

  for (const c of candidates) {
    const abs = path.resolve(root, c);
    if (fs.existsSync(abs)) return abs;
  }
  return undefined;
}

function kindOf(decl: ts.Declaration): SymbolDoc["kind"] {
  if (ts.isFunctionDeclaration(decl) || ts.isFunctionExpression(decl) || ts.isArrowFunction(decl))
    return "function";
  if (ts.isClassDeclaration(decl)) return "class";
  if (ts.isInterfaceDeclaration(decl)) return "interface";
  if (ts.isTypeAliasDeclaration(decl)) return "type";
  if (ts.isVariableDeclaration(decl)) return "constant";
  return "unknown";
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

/** Extract exported symbols (with JSDoc/TSDoc) from a package entry point. */
export function extractExports(root: string, pkg: Record<string, unknown>): SymbolDoc[] {
  const entry = resolveEntry(root, pkg);
  if (!entry) return [];

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
        symbols.push(symbolFromDecl(sym.getName(), decl, decl, checker, root));
      } catch {
        // Skip a single malformed export rather than failing the whole build.
        continue;
      }
    }
  }

  // ESM found nothing — the entry may be CommonJS (`module.exports = ...`).
  const result = symbols.length > 0 ? symbols : extractCjsExports(sourceFile, checker, root, pkg);

  return result.sort((a, b) => a.name.localeCompare(b.name));
}
