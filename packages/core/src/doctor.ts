import { extractFromSource } from "./extract.js";
import type { SymbolDoc } from "./types.js";

export interface DoctorIssue {
  symbol: string;
  kind: SymbolDoc["kind"];
  severity: "error" | "warning" | "info";
  message: string;
  sourceFile?: string;
}

export interface DoctorReport {
  /** 0-100, rounded. */
  score: number;
  totalSymbols: number;
  documentedSymbols: number;
  paramsTotal: number;
  paramsDocumented: number;
  returnsTotal: number;
  returnsDocumented: number;
  examplesTotal: number;
  issues: DoctorIssue[];
}

/**
 * A symbol counts as documented when it has a description; types/interfaces
 * without descriptions but with documented members still need one to count.
 */
function isDocumented(s: SymbolDoc): boolean {
  return typeof s.description === "string" && s.description.trim().length > 0;
}

function scoreFor(
  symbolsTotal: number,
  documented: number,
  params: { total: number; documented: number },
  returns: { total: number; documented: number },
  examples: { runnable: number; with: number },
): number {
  // Weights: documentation presence dominates; params, returns, examples add up.
  const docW = 60;
  const paramW = 20;
  const retW = 10;
  const exampleW = 10;

  const docScore = symbolsTotal === 0 ? docW : (documented / symbolsTotal) * docW;
  const paramScore =
    params.total === 0 ? paramW : (params.documented / params.total) * paramW;
  const retScore =
    returns.total === 0 ? retW : (returns.documented / returns.total) * retW;
  const exampleScore =
    examples.runnable === 0 ? exampleW : (examples.with / examples.runnable) * exampleW;

  return Math.round(docScore + paramScore + retScore + exampleScore);
}

/**
 * Analyze the extracted symbol set for documentation coverage and quality.
 * Pure analysis — no filesystem access beyond what extraction already did.
 */
export function analyzeSymbols(
  title: string,
  symbols: SymbolDoc[],
): DoctorReport {
  const issues: DoctorIssue[] = [];
  let documentedSymbols = 0;
  let paramsTotal = 0;
  let paramsDocumented = 0;
  let returnsTotal = 0;
  let returnsDocumented = 0;
  let examplesTotal = 0;
  const runnableKinds = new Set(["function", "class"]);
  let runnableTotal = 0;
  let runnableWithExamples = 0;

  for (const s of symbols) {
    const where = s.sourceFile;

    if (!isDocumented(s)) {
      issues.push({
        symbol: s.name,
        kind: s.kind,
        severity: "error",
        message: "no description",
        sourceFile: where,
      });
    } else {
      documentedSymbols++;
    }

    if (s.kind === "function" || s.kind === "class") {
      runnableTotal++;
      if (s.examples.length > 0) runnableWithExamples++;
      for (const p of s.params) {
        paramsTotal++;
        if (p.description && p.description.trim().length > 0) {
          paramsDocumented++;
        } else {
          issues.push({
            symbol: `${s.name}(${p.name})`,
            kind: s.kind,
            severity: "warning",
            message: `parameter "${p.name}" is undocumented`,
            sourceFile: where,
          });
        }
      }
    }

    if (s.kind === "function" && s.returns?.type) {
      returnsTotal++;
      if (s.returns.description && s.returns.description.trim().length > 0) {
        returnsDocumented++;
      } else {
        issues.push({
          symbol: s.name,
          kind: s.kind,
          severity: "warning",
          message: `return value (${s.returns.type}) is undocumented`,
          sourceFile: where,
        });
      }
    }

    examplesTotal += s.examples.length;
    if ((s.kind === "function" || s.kind === "class") && s.examples.length === 0) {
      issues.push({
        symbol: s.name,
        kind: s.kind,
        severity: "info",
        message: "no usage example",
        sourceFile: where,
      });
    }
  }

  const score = scoreFor(
    symbols.length,
    documentedSymbols,
    { total: paramsTotal, documented: paramsDocumented },
    { total: returnsTotal, documented: returnsDocumented },
    { runnable: runnableTotal, with: runnableWithExamples },
  );

  return {
    score,
    totalSymbols: symbols.length,
    documentedSymbols,
    paramsTotal,
    paramsDocumented,
    returnsTotal,
    returnsDocumented,
    examplesTotal,
    issues,
  };
}

/** Run extraction and produce a full doctor report for a source. */
export function diagnose(source: { root: string; name?: string }): DoctorReport & {
  title: string;
} {
  const extracted = extractFromSource(source);
  const report = analyzeSymbols(extracted.title, extracted.symbols);
  return { title: extracted.title, ...report };
}

const SVG_BADGE = (label: string, value: string, color: string): string =>
  `<svg xmlns="http://www.w3.org/2000/svg" width="116" height="20" role="img" aria-label="${label}: ${value}"><title>${label}: ${value}</title><linearGradient id="s" x2="0" y2="100%"><stop offset="0" stop-color="#bbb" stop-opacity=".1"/><stop offset="1" stop-opacity=".1"/></linearGradient><clipPath id="r"><rect width="116" height="20" rx="3" fill="#fff"/></clipPath><g clip-path="url(#r)"><rect width="61" height="20" fill="#555"/><rect x="61" width="55" height="20" fill="${color}"/><rect width="116" height="20" fill="url(#s)"/></g><g fill="#fff" text-anchor="middle" font-family="Verdana,Geneva,DejaVu Sans,sans-serif" font-size="110" text-rendering="geometricPrecision"><text x="305" y="140" transform="scale(.1)" fill="#010101" fill-opacity=".3">${label}</text><text x="305" y="130" transform="scale(.1)" fill="#fff">${label}</text><text x="885" y="140" transform="scale(.1)" fill="#010101" fill-opacity=".3">${value}</text><text x="885" y="130" transform="scale(.1)" fill="#fff">${value}</text></g></svg>`;

function colorFor(score: number): string {
  if (score >= 90) return "#4c1"; // bright green
  if (score >= 75) return "#97ca00"; // green
  if (score >= 60) return "#dfb317"; // yellow
  if (score >= 40) return "#fe7d37"; // orange
  return "#cb2431"; // red
}

/** Codecov-style SVG badge for a doctor report. */
export function badgeSvg(report: DoctorReport): string {
  return SVG_BADGE("docs", `${report.score}%`, colorFor(report.score));
}
