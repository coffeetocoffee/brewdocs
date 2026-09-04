import * as fs from "node:fs";
import * as path from "node:path";
import ts from "typescript";
import type { SymbolDoc } from "../types.js";
import { parseJsDoc } from "./jsdoc.js";

function resolveEntry(root: string, pkg: Record<string, unknown>): string | undefined {
  const candidates: string[] = [];

  const exp = pkg.exports;
  if (exp && typeof exp === "object") {
    const dot = (exp as Record<string, unknown>)["."];
    if (typeof dot === "string") candidates.push(dot);
    else if (dot && typeof dot === "object") {
      const o = dot as Record<string, unknown>;
      const imp = (o.import ?? o.require ?? o.default) as unknown;
      if (typeof imp === "string") candidates.push(imp);
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

function declarationOf(symbol: ts.Symbol): ts.Declaration | undefined {
  let sym = symbol;
  if (sym.flags & ts.SymbolFlags.Alias) {
    // getAliasedSymbol can throw for ambient types; guard it.
    try {
      sym = sym as unknown as { getAliasedSymbol?(): ts.Symbol };
      const aliased = (symbol as unknown as {
        getAliasedSymbol?(): ts.Symbol;
      }).getAliasedSymbol?.();
      if (aliased) sym = aliased;
    } catch {
      /* keep original */
    }
  }
  return sym.declarations?.[0];
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

  const moduleSymbol = checker.getSymbolAtLocation(sourceFile);
  if (!moduleSymbol) return [];

  let exported: ts.Symbol[] = [];
  try {
    exported = checker.getExportsOfModule(moduleSymbol);
  } catch {
    return [];
  }
  const symbols: SymbolDoc[] = [];

  for (const sym of exported) {
    try {
      const decl = declarationOf(sym);
      if (!decl) continue;
    const name = sym.getName();
    const kind = kindOf(decl as ts.Declaration);
    const signature =
      decl.getText(sourceFile).split("\n").slice(0, 6).join("\n").trim() || undefined;
    const jsdoc = parseJsDoc(decl);

    // Enrich params/returns with types from the actual AST (JSDoc often
    // omits types, which live on the declaration instead).
    if (ts.isFunctionLike(decl)) {
      jsdoc.params = decl.parameters.map((p, i) => {
        const pname = p.name.getText();
        const ptype = p.type
          ? p.type.getText()
          : checker.typeToString(checker.getTypeAtLocation(p));
        const optional = Boolean(p.questionToken || p.initializer);
        const existing =
          jsdoc.params.find((x) => x.name === pname) ?? jsdoc.params[i];
        return {
          name: pname,
          type: ptype,
          description: existing?.description ?? "",
          optional: optional || Boolean(existing?.optional),
          default: existing?.default,
        };
      });

      const sigDecl = checker.getSignatureFromDeclaration(
        decl as ts.SignatureDeclaration,
      );
      if (sigDecl && !jsdoc.returns?.type) {
        const rt = checker.typeToString(sigDecl.getReturnType());
        jsdoc.returns = {
          type: rt,
          description: jsdoc.returns?.description ?? "",
        };
      }
    }

    symbols.push({
      name,
      kind,
      signature,
      description: jsdoc.description || undefined,
      params: jsdoc.params,
      returns: jsdoc.returns || undefined,
      examples: jsdoc.examples,
      deprecated: jsdoc.deprecated || undefined,
      sourceFile: path.relative(root, decl.getSourceFile().fileName),
    });
    } catch {
      // Skip a single malformed export rather than failing the whole build.
      continue;
    }
  }

  return symbols.sort((a, b) => a.name.localeCompare(b.name));
}
