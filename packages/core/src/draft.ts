import * as fs from "node:fs";
import * as path from "node:path";
import ts from "typescript";
import { extractFromSource } from "./extract.js";
import { replacementHint } from "./replacements.js";
import type { SymbolDoc } from "./types.js";

/**
 * v1.0.0 — `brewdocs draft`: type-driven JSDoc scaffolding. Doctor grades
 * coverage; draft turns that grade into a starting point by generating a JSDoc
 * skeleton (params / returns / type params / `@deprecated` successor) above
 * every undocumented exported symbol. The description line is intentionally
 * left empty so the author still has to write it — applying a draft must not
 * artificially inflate the coverage score.
 */

export interface DraftProposal {
  /** Absolute path of the file the JSDoc would be inserted into. */
  file: string;
  /** 1-based line where the declaration starts. */
  line: number;
  /** Character offset in the file where the JSDoc block should be inserted. */
  pos: number;
  symbol: string;
  kind: SymbolDoc["kind"];
  /** The JSDoc block to insert (block comment, no trailing newline). */
  jsdoc: string;
}

const PROGRAM_OPTIONS: ts.CompilerOptions = {
  target: ts.ScriptTarget.ESNext,
  module: ts.ModuleKind.ESNext,
  moduleResolution: ts.ModuleResolutionKind.Bundler,
  allowJs: true,
  checkJs: false,
  skipLibCheck: true,
  noEmit: true,
  types: [],
};

/** Minimal mirror of the entry resolution in `extractors/exports.ts`. */
export function resolveEntry(root: string, pkg: Record<string, unknown>): string | undefined {
  const candidates: string[] = [];
  const exp = pkg.exports;
  if (exp && typeof exp === "object") {
    const dot = (exp as Record<string, unknown>)["."];
    if (typeof dot === "string") candidates.push(dot);
    else if (dot && typeof dot === "object") {
      for (const key of ["types", "import", "require", "default"]) {
        const v = (dot as Record<string, unknown>)[key];
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

/** Find the top-level exported declaration matching name + kind in a file. */
function findDeclaration(
  sf: ts.SourceFile,
  name: string,
): ts.Node | undefined {
  for (const st of sf.statements) {
    if (ts.isFunctionDeclaration(st) && st.name?.getText(sf) === name) return st;
    if (ts.isClassDeclaration(st) && st.name?.getText(sf) === name) return st;
    if (ts.isInterfaceDeclaration(st) && st.name?.getText(sf) === name) return st;
    if (ts.isTypeAliasDeclaration(st) && st.name.getText(sf) === name) return st;
    if (ts.isVariableStatement(st)) {
      for (const d of st.declarationList.declarations) {
        if (ts.isIdentifier(d.name) && d.name.getText(sf) === name) return st;
      }
    }
  }
  return undefined;
}

function hasJsDoc(node: ts.Node): boolean {
  return ts.getJSDocCommentsAndTags(node).length > 0;
}

/** Build the JSDoc skeleton for a symbol. Description line is left empty. */
export function jsdocStub(sym: SymbolDoc): string {
  const lines: string[] = ["/**"];
  lines.push(" *");
  for (const tp of sym.typeParams ?? []) {
    lines.push(` * @template ${tp.name}${tp.constraint ? ` ${tp.constraint}` : ""}`);
  }
  for (const p of sym.params) {
    const idx = sym.params.indexOf(p);
    const type = p.type ?? sym.resolvedParams?.[idx] ?? "";
    const opt = p.optional ? "?" : "";
    const typePart = type ? `{${type}${opt}} ` : "";
    lines.push(` * @param ${typePart}${p.name} -`);
  }
  if (sym.returns?.type) {
    lines.push(` * @returns {${sym.returns.type}} -`);
  }
  if (sym.deprecated) {
    const hint = replacementHint(sym.replacements);
    lines.push(` * @deprecated${hint ? ` ${hint}` : ""}`);
  }
  lines.push(" */");
  return lines.join("\n");
}

/**
 * Propose JSDoc drafts for every undocumented exported symbol that physically
 * lives in the package entry file. Re-exports (`export { x } from "./x"`) are
 * skipped because the declaration isn't in this file.
 */
export function buildDrafts(source: { root: string; name?: string }): DraftProposal[] {
  const extracted = extractFromSource(source);
  if (!extracted.symbols.length) return [];
  const entry = resolveEntry(source.root, extracted.metadata);
  if (!entry) return [];

  const program = ts.createProgram([entry], PROGRAM_OPTIONS);
  const sf = program.getSourceFile(entry);
  if (!sf) return [];

  const proposals: DraftProposal[] = [];
  for (const sym of extracted.symbols) {
    if (!sym.sourceFile) continue;
    if (path.resolve(source.root, sym.sourceFile) !== entry) continue;
    if (sym.description && sym.description.trim().length > 0) continue;

    const node = findDeclaration(sf, sym.name);
    if (!node) continue;
    if (hasJsDoc(node)) continue;

    const pos = node.getStart(sf);
    const line = sf.getLineAndCharacterOfPosition(pos).line + 1;
    proposals.push({
      file: entry,
      line,
      pos,
      symbol: sym.name,
      kind: sym.kind,
      jsdoc: jsdocStub(sym),
    });
  }
  return proposals;
}

/**
 * Insert the proposed JSDoc blocks into their files. Edits happen per file,
 * from the highest position to the lowest, so earlier positions stay valid.
 * Returns the list of files that were modified.
 */
export function applyDrafts(proposals: DraftProposal[]): string[] {
  const byFile = new Map<string, DraftProposal[]>();
  for (const p of proposals) {
    if (!byFile.has(p.file)) byFile.set(p.file, []);
    byFile.get(p.file)!.push(p);
  }

  const changed: string[] = [];
  for (const [file, props] of byFile) {
    let text = fs.readFileSync(file, "utf8");
    const sorted = [...props].sort((a, b) => b.pos - a.pos);
    for (const p of sorted) {
      const lineStart = text.lastIndexOf("\n", p.pos - 1) + 1;
      const indent = text.slice(lineStart, p.pos);
      const block = p.jsdoc
        .split("\n")
        .map((l, i) => (i === 0 ? l : indent + l))
        .join("\n");
      text = text.slice(0, p.pos) + block + "\n" + text.slice(p.pos);
    }
    fs.writeFileSync(file, text, "utf8");
    changed.push(file);
  }
  return changed;
}
