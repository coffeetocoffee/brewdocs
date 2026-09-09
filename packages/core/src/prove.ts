import * as fs from "node:fs";
import * as path from "node:path";
import ts from "typescript";
import { extractFromSource } from "./extract.js";
import { resolveEntry } from "./draft.js";
import type { SymbolDoc } from "./types.js";

/**
 * v1.0.0 — `brewdocs prove`: run what `doctor` counts. `doctor` only counts
 * `@example` snippets; `prove` actually typechecks each one against the real
 * package so a doc example that no longer compiles can't pass silently.
 *
 * Proof is a TypeScript typecheck (semantic + syntactic) of the snippet run
 * inside a file that imports the package's exported symbols — a safe sandbox
 * that needs no execution. Examples that aren't code (prose, empty after
 * stripping a code fence) are skipped rather than failed.
 */

export interface ProveResult {
  symbol: string;
  /** Index of the example within the symbol's `examples` array. */
  index: number;
  /** The cleaned snippet that was checked. */
  example: string;
  ok: boolean;
  /** Diagnostic text when `ok` is false. */
  error?: string;
  /** True when the example was not code and so not proven. */
  skipped?: boolean;
}

const PROVE_OPTIONS: ts.CompilerOptions = {
  target: ts.ScriptTarget.ESNext,
  module: ts.ModuleKind.ESNext,
  moduleResolution: ts.ModuleResolutionKind.Bundler,
  allowImportingTsExtensions: true,
  skipLibCheck: true,
  noEmit: true,
  types: [],
};

const VALUE_KINDS = new Set<SymbolDoc["kind"]>(["function", "class", "constant"]);
const TYPE_KINDS = new Set<SymbolDoc["kind"]>(["interface", "type"]);

/** Strip a leading/trailing triple-backtick code fence if present. */
function stripFence(text: string): string {
  const trimmed = text.trim();
  const fenced = /^```[a-zA-Z]*\n([\s\S]*?)\n?```$/.exec(trimmed);
  return (fenced ? fenced[1] : trimmed).trim();
}

/**
 * Heuristic: is this snippet code we can typecheck, or prose? Examples like
 * "See the usage guide" carry no code tokens, so we skip them rather than fail
 * them — only real snippets get proven.
 */
function looksLikeCode(snippet: string): boolean {
  return /[();={}]|=>|\b(import|function|class|new|return|await|const|let|var|export|interface|type)\b|`/.test(
    snippet,
  );
}

function typecheckExample(
  snippet: string,
  valueNames: string[],
  typeNames: string[],
  entrySpec: string,
  root: string,
): { ok: boolean; error?: string } {
  const header = [
    valueNames.length
      ? `import { ${valueNames.join(", ")} } from ${JSON.stringify(entrySpec)};`
      : "",
    typeNames.length
      ? `import type { ${typeNames.join(", ")} } from ${JSON.stringify(entrySpec)};`
      : "",
  ]
    .filter(Boolean)
    .join("\n");

  const code = `${header}\n${snippet}\n`;
  const tmp = path.join(
    root,
    `.brewdocs-prove-${Date.now()}-${Math.random().toString(36).slice(2)}.ts`,
  );
  fs.writeFileSync(tmp, code, "utf8");
  try {
    const program = ts.createProgram([tmp], PROVE_OPTIONS);
    const sf = program.getSourceFile(tmp);
    if (!sf) return { ok: false, error: "could not compile example" };
    const diags = [
      ...program.getSyntacticDiagnostics(sf),
      ...program.getSemanticDiagnostics(sf),
    ];
    if (diags.length === 0) return { ok: true };
    const error = diags
      .slice(0, 5)
      .map((d) => ts.flattenDiagnosticMessageText(d.messageText, "\n"))
      .join("\n");
    return { ok: false, error };
  } finally {
    fs.rmSync(tmp, { force: true });
  }
}

/**
 * Prove every `@example` snippet in the extracted API by typechecking it
 * against the package. Returns one `ProveResult` per proven example.
 */
export function proveSource(source: { root: string; name?: string }): ProveResult[] {
  const extracted = extractFromSource(source);
  if (!extracted.symbols.length) return [];
  const entry = resolveEntry(source.root, extracted.metadata);
  if (!entry) return [];

  const entrySpec = `./${path
    .relative(source.root, entry)
    .replace(/\\/g, "/")
    .replace(/\.tsx?$/, "")}`;
  const valueNames = extracted.symbols
    .filter((s) => VALUE_KINDS.has(s.kind))
    .map((s) => s.name);
  const typeNames = extracted.symbols
    .filter((s) => TYPE_KINDS.has(s.kind))
    .map((s) => s.name);

  const results: ProveResult[] = [];
  for (const sym of extracted.symbols) {
    sym.examples.forEach((raw, i) => {
      const snippet = stripFence(raw);
      if (!snippet || !looksLikeCode(snippet)) {
        results.push({ symbol: sym.name, index: i, example: raw, ok: false, skipped: true });
        return;
      }
      const res = typecheckExample(snippet, valueNames, typeNames, entrySpec, source.root);
      results.push({ symbol: sym.name, index: i, example: snippet, ...res });
    });
  }
  return results;
}

export function proveSummary(results: ProveResult[]): {
  proven: number;
  passed: number;
  failed: number;
  skipped: number;
} {
  const proven = results.filter((r) => !r.skipped);
  return {
    proven: proven.length,
    passed: proven.filter((r) => r.ok).length,
    failed: proven.filter((r) => !r.ok).length,
    skipped: results.filter((r) => r.skipped).length,
  };
}
