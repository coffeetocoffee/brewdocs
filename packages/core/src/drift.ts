import * as fs from "node:fs";
import * as path from "node:path";
import type { SymbolDoc } from "./types.js";

/**
 * v3.5 doc drift detection: "code changed, docs didn't". Every symbol splits
 * into two fingerprints — the code surface (kind, signature, params, members,
 * generics) and the docs surface (prose, examples, tags). A baseline snapshot
 * records both; a later comparison flags symbols whose code moved on while
 * their docs stayed identical — the one signal review tends to miss.
 */

export interface SymbolDriftState {
  name: string;
  kind: SymbolDoc["kind"];
  /** Fingerprint of the code-facing surface. */
  code: string;
  /** Fingerprint of the docs-facing surface. */
  docs: string;
}

export interface DriftSnapshot {
  /** Snapshot format version; bump when the fingerprint shape changes. */
  format: 1;
  recordedAt: string;
  /** Human label for the baseline (package version or git ref). */
  label: string;
  symbols: SymbolDriftState[];
}

export type DriftStatus =
  | "in-sync"
  | "stale-docs"
  | "docs-updated"
  | "new-symbol"
  | "removed-symbol";

export interface DriftEntry {
  name: string;
  kind: SymbolDoc["kind"];
  status: DriftStatus;
}

export interface DriftReport {
  title: string;
  baseline: string;
  current: string;
  entries: DriftEntry[];
  /** The actionable subset: code changed while docs stayed identical. */
  stale: DriftEntry[];
  codeChanged: number;
  docsUpdated: number;
  added: number;
  removed: number;
  summary: string;
}

const norm = (s: string): string => s.replace(/\s+/g, " ").trim();

/** Strip comments so docs written *inside* a declaration aren't code changes. */
function stripComments(text: string): string {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/\/\/[^\n]*/g, " ");
}

/**
 * Raw-signature fallback for declarations with no structured fields (type
 * aliases, constants). The signature text can include the declaration body
 * (`function f() { ... }`), which would make every body edit look like drift
 * — so it is only used when params/return/members carry nothing, and comments
 * are stripped so inline JSDoc edits don't masquerade as code movement.
 */
function rawSignature(s: SymbolDoc): string {
  const hasStructured =
    s.resolvedParams !== undefined ||
    s.resolvedReturn !== undefined ||
    s.params.length > 0 ||
    s.members !== undefined;
  if (hasStructured) return "";
  let text = norm(stripComments(s.signature ?? ""));
  // Function-valued constants (`export const f = () => { ... }`) never get
  // structured params (the declaration is a variable, not function-like), so
  // keep only the head: body edits are implementation, not API movement.
  if (s.kind === "constant" && /=>|\bfunction\b/.test(text)) {
    const brace = text.indexOf("{");
    if (brace >= 0) text = text.slice(0, brace).trim();
  }
  return text;
}

/**
 * Code-facing fingerprint: anything a consumer's code can observe. Return
 * type lives here (not in the docs fp) so a bare `string` -> `number` change
 * counts as code movement even when the signature text lags.
 */
export function codeFingerprint(s: SymbolDoc): string {
  return JSON.stringify({
    k: s.kind,
    sig: rawSignature(s),
    p: s.params.map((p) => [p.name, p.type ?? "", Boolean(p.optional), p.default ?? ""]),
    rt: s.returns?.type ?? "",
    rp: s.resolvedParams ?? null,
    rr: s.resolvedReturn ?? null,
    m: (s.members ?? []).map((m) => [
      m.name,
      m.kind,
      norm(m.signature ?? ""),
      m.type ?? "",
      m.visibility ?? "",
      Boolean(m.static),
      Boolean(m.readonly),
    ]),
    t: (s.typeParams ?? []).map((t) => [t.name, t.constraint ?? "", t.default ?? ""]),
  });
}

/**
 * Docs-facing fingerprint: the human-written prose. Descriptions key by
 * symbol/member/param name and empty descriptions are skipped, so "added an
 * undocumented param" reads as docs-unchanged (drift), while "renamed a param
 * and updated its JSDoc" reads as docs-updated.
 */
export function docsFingerprint(s: SymbolDoc): string {
  const descMap = (
    items: Array<{ name: string; description?: string }>,
  ): Record<string, string> => {
    const out: Record<string, string> = {};
    for (const item of items) {
      const d = norm(item.description ?? "");
      if (d) out[item.name] = d;
    }
    return out;
  };
  return JSON.stringify({
    d: norm(s.description ?? ""),
    p: descMap(s.params),
    r: norm(s.returns?.description ?? ""),
    m: descMap(s.members ?? []),
    e: s.examples.map(norm),
    th: (s.throws ?? []).map(norm),
    see: (s.see ?? []).map(norm),
    dep: s.deprecated === true ? true : norm(String(s.deprecated ?? "")),
  });
}

/** Build a baseline snapshot from an extraction (sorted for stable diffs). */
export function snapshotOf(
  label: string,
  symbols: SymbolDoc[],
  recordedAt: string = new Date().toISOString(),
): DriftSnapshot {
  return {
    format: 1,
    recordedAt,
    label,
    symbols: symbols
      .map((s) => ({
        name: s.name,
        kind: s.kind,
        code: codeFingerprint(s),
        docs: docsFingerprint(s),
      }))
      .sort((a, b) => a.name.localeCompare(b.name)),
  };
}

/**
 * Compare a baseline snapshot against a fresh extraction. A symbol whose code
 * fingerprint changed while its docs fingerprint stayed identical is stale —
 * the build keeps succeeding but the docs now describe old code.
 */
export function compareDrift(
  baseline: DriftSnapshot,
  current: { title: string; label: string; symbols: SymbolDoc[] },
): DriftReport {
  const baseByName = new Map(baseline.symbols.map((s) => [s.name, s]));
  const entries: DriftEntry[] = [];
  let codeChanged = 0;
  let docsUpdated = 0;
  let added = 0;

  for (const sym of current.symbols) {
    const base = baseByName.get(sym.name);
    if (!base) {
      entries.push({ name: sym.name, kind: sym.kind, status: "new-symbol" });
      added++;
      continue;
    }
    const code = codeFingerprint(sym) !== base.code;
    const docs = docsFingerprint(sym) !== base.docs;
    if (code) codeChanged++;
    if (docs) docsUpdated++;
    entries.push({
      name: sym.name,
      kind: sym.kind,
      status: code && !docs ? "stale-docs" : docs ? "docs-updated" : "in-sync",
    });
  }

  const currentNames = new Set(current.symbols.map((s) => s.name));
  let removed = 0;
  for (const b of baseline.symbols) {
    if (currentNames.has(b.name)) continue;
    entries.push({ name: b.name, kind: b.kind, status: "removed-symbol" });
    removed++;
  }
  entries.sort((a, b) => a.name.localeCompare(b.name));

  const stale = entries.filter((e) => e.status === "stale-docs");
  const summary =
    stale.length === 0
      ? "No drift detected — docs are in step with the code."
      : `${stale.length} symbol(s) drifted: code changed, docs didn't.`;

  return {
    title: current.title,
    baseline: baseline.label,
    current: current.label,
    entries,
    stale,
    codeChanged,
    docsUpdated,
    added,
    removed,
    summary,
  };
}

/** Baseline snapshot lives beside the coverage history (commit-friendly). */
export function driftFilePath(root: string): string {
  return path.join(root, ".brewdocs", "drift.json");
}

export function loadDriftSnapshot(root: string): DriftSnapshot | null {
  try {
    const raw = JSON.parse(fs.readFileSync(driftFilePath(root), "utf8")) as DriftSnapshot;
    // Older formats may have a different fingerprint shape: treat as missing
    // so the caller re-records instead of reporting bogus drift.
    if (raw && raw.format === 1 && Array.isArray(raw.symbols)) return raw;
  } catch {
    /* missing or corrupt baseline: caller decides how to degrade */
  }
  return null;
}

export function saveDriftSnapshot(root: string, snapshot: DriftSnapshot): string {
  const file = driftFilePath(root);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(snapshot, null, 2) + "\n", "utf8");
  return file;
}

/** Terminal report: stale symbols first (the actionable list), then counts. */
export function renderDriftText(report: DriftReport): string {
  const lines: string[] = [];
  lines.push(
    `🌊 drift — ${report.stale.length} stale · ${report.codeChanged} code change(s) · ${report.docsUpdated} docs update(s) · +${report.added} new · -${report.removed} removed`,
  );
  lines.push(`   baseline: ${report.baseline} → current: ${report.current}`);
  if (report.stale.length === 0) {
    lines.push("   no drift detected — docs are in step with the code. ☕");
    return lines.join("\n");
  }
  for (const e of report.stale) {
    lines.push(`   ✗ ${e.name} (${e.kind}) — code changed, docs unchanged`);
  }
  lines.push(
    "   hint: refresh the JSDoc for these symbols (brewdocs draft --fix), or record a new baseline (brewdocs drift --record)",
  );
  return lines.join("\n");
}
