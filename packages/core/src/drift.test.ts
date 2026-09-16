import { afterEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  codeFingerprint,
  compareDrift,
  docsFingerprint,
  driftFilePath,
  loadDriftSnapshot,
  renderDriftText,
  saveDriftSnapshot,
  snapshotOf,
} from "./drift.js";
import { extractFromSource } from "./extract.js";
import type { SymbolDoc } from "./types.js";

let tmpDirs: string[] = [];

function tmpDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "brewdocs-drift-"));
  tmpDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tmpDirs) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  tmpDirs = [];
});

function sym(partial: Partial<SymbolDoc> & { name: string }): SymbolDoc {
  return { kind: "function", params: [], examples: [], ...partial };
}

/** A small JS package fixture whose code we can mutate between extractions. */
function fixtureSource(body: string): string {
  const root = tmpDir();
  fs.writeFileSync(
    path.join(root, "package.json"),
    JSON.stringify({ name: "fixture", version: "1.0.0", main: "index.js" }),
    "utf8",
  );
  fs.writeFileSync(path.join(root, "index.js"), body, "utf8");
  return root;
}

const DOCUMENTED = `/**
 * Brew a cup.
 * @param {string} kind - what to brew
 * @returns {string} the cup
 */
export function brew(kind) { return "cup of " + kind; }
`;

describe("v3.5 drift — fingerprints", () => {
  it("code fingerprint moves on signature/param changes, not docs edits", () => {
    const a = sym({ name: "f", signature: "f(a: string): void", description: "old" });
    const b = sym({ name: "f", signature: "f(a: string, b: number): void", description: "old" });
    expect(codeFingerprint(a)).not.toBe(codeFingerprint(b));

    const c = sym({ name: "f", signature: "f(a: string): void", description: "new prose" });
    expect(codeFingerprint(a)).toBe(codeFingerprint(c));
  });

  it("docs fingerprint moves on prose, param docs, examples and tags only", () => {
    const a = sym({ name: "f", description: "old", params: [{ name: "x", description: "old" }] });
    const b = sym({ name: "f", description: "new", params: [{ name: "x", description: "old" }] });
    expect(docsFingerprint(a)).not.toBe(docsFingerprint(b));

    const c = sym({ name: "f", description: "old", params: [{ name: "x", description: "new" }] });
    expect(docsFingerprint(a)).not.toBe(docsFingerprint(c));

    const d = sym({ name: "f", description: "old", params: [{ name: "x", description: "old" }], examples: ["f()"] });
    expect(docsFingerprint(a)).not.toBe(docsFingerprint(d));

    // Signature-only change: docs fingerprint must NOT move.
    const e = sym({
      name: "f",
      signature: "f(a: number): void",
      description: "old",
      params: [{ name: "x", description: "old" }],
    });
    expect(docsFingerprint(a)).toBe(docsFingerprint(e));
  });

  it("empty/undefined descriptions are equivalent (no phantom docs updates)", () => {
    const a = sym({ name: "f", description: undefined });
    const b = sym({ name: "f", description: "" });
    expect(docsFingerprint(a)).toBe(docsFingerprint(b));
  });

  it("ignores comment text inside raw signatures (no structured fields)", () => {
    const a = sym({
      name: "T",
      kind: "type",
      signature: "type T = {\n  /** old note */\n  x: string;\n}",
    });
    const b = sym({
      name: "T",
      kind: "type",
      signature: "type T = {\n  /** new note */\n  x: string;\n}",
    });
    expect(codeFingerprint(a)).toBe(codeFingerprint(b));
    // A real type change still moves the fingerprint.
    const c = sym({ name: "T", kind: "type", signature: "type T = {\n  x: number;\n}" });
    expect(codeFingerprint(a)).not.toBe(codeFingerprint(c));
  });

  it("function-valued constants keep only the head (body edits are not drift)", () => {
    const a = sym({
      name: "make",
      kind: "constant",
      signature: "export const make = (size) => ({ size })",
    });
    const b = sym({
      name: "make",
      kind: "constant",
      signature: "export const make = (size) => ({ size, hot: true })",
    });
    expect(codeFingerprint(a)).toBe(codeFingerprint(b));
    // A signature/head change still moves it.
    const c = sym({
      name: "make",
      kind: "constant",
      signature: "export const make = (size, lid) => ({ size })",
    });
    expect(codeFingerprint(a)).not.toBe(codeFingerprint(c));
  });
});

describe("v3.5 drift — comparison", () => {
  it("flags stale docs when code moved and docs stayed identical", () => {
    const baseline = snapshotOf("1.0.0", [
      sym({
        name: "brew",
        signature: "brew(kind: string): string",
        description: "Brew a cup.",
        params: [{ name: "kind", type: "string", description: "what to brew" }],
      }),
    ]);
    const report = compareDrift(baseline, {
      title: "fixture",
      label: "1.1.0",
      symbols: [
        sym({
          name: "brew",
          signature: "brew(kind: string, strength: number): string",
          description: "Brew a cup.",
          params: [
            { name: "kind", type: "string", description: "what to brew" },
            { name: "strength", type: "number" },
          ],
        }),
      ],
    });
    expect(report.stale.map((e) => e.name)).toEqual(["brew"]);
    expect(report.codeChanged).toBe(1);
    expect(report.docsUpdated).toBe(0);
    expect(report.summary).toContain("drifted");
    expect(report.entries[0].status).toBe("stale-docs");
  });

  it("does not flag when docs moved too, or when nothing moved", () => {
    const baseline = snapshotOf("1.0.0", [
      sym({ name: "a", signature: "a(): void", description: "old" }),
      sym({ name: "b", signature: "b(): void", description: "same" }),
    ]);
    const report = compareDrift(baseline, {
      title: "fixture",
      label: "1.1.0",
      symbols: [
        sym({ name: "a", signature: "a(x: number): void", description: "new" }),
        sym({ name: "b", signature: "b(): void", description: "same" }),
      ],
    });
    expect(report.stale).toHaveLength(0);
    expect(report.entries.find((e) => e.name === "a")?.status).toBe("docs-updated");
    expect(report.entries.find((e) => e.name === "b")?.status).toBe("in-sync");
    expect(report.summary).toContain("No drift");
  });

  it("reports added and removed symbols", () => {
    const baseline = snapshotOf("1.0.0", [sym({ name: "gone", signature: "gone(): void" })]);
    const report = compareDrift(baseline, {
      title: "fixture",
      label: "2.0.0",
      symbols: [sym({ name: "fresh", signature: "fresh(): void" })],
    });
    expect(report.added).toBe(1);
    expect(report.removed).toBe(1);
    expect(report.entries.map((e) => e.status).sort()).toEqual(["new-symbol", "removed-symbol"]);
    // Additions/removals alone are not drift.
    expect(report.stale).toHaveLength(0);
  });
});

describe("v3.5 drift — snapshot IO", () => {
  it("round-trips through .brewdocs/drift.json", () => {
    const root = tmpDir();
    const snapshot = snapshotOf("1.0.0", [sym({ name: "f", signature: "f(): void" })]);
    const file = saveDriftSnapshot(root, snapshot);
    expect(file).toBe(driftFilePath(root));
    expect(fs.existsSync(file)).toBe(true);
    const loaded = loadDriftSnapshot(root);
    expect(loaded?.label).toBe("1.0.0");
    expect(loaded?.symbols).toHaveLength(1);
    expect(loaded?.symbols[0].name).toBe("f");
  });

  it("returns null for a missing or corrupt baseline", () => {
    const root = tmpDir();
    expect(loadDriftSnapshot(root)).toBeNull();
    fs.mkdirSync(path.join(root, ".brewdocs"), { recursive: true });
    fs.writeFileSync(driftFilePath(root), "not json", "utf8");
    expect(loadDriftSnapshot(root)).toBeNull();
    // Wrong format version is treated as absent, never as bogus drift.
    fs.writeFileSync(driftFilePath(root), JSON.stringify({ format: 0, symbols: [] }), "utf8");
    expect(loadDriftSnapshot(root)).toBeNull();
  });

  it("renders a readable terminal report", () => {
    const baseline = snapshotOf("1.0.0", [
      sym({ name: "f", signature: "f(): void", description: "d" }),
    ]);
    const report = compareDrift(baseline, {
      title: "fixture",
      label: "1.1.0",
      symbols: [sym({ name: "f", signature: "f(x: number): void", description: "d" })],
    });
    const text = renderDriftText(report);
    expect(text).toContain("drift");
    expect(text).toContain("f");
    expect(text).toContain("baseline: 1.0.0");

    const clean = renderDriftText(
      compareDrift(baseline, { title: "fixture", label: "1.1.0", symbols: [sym({ name: "f", signature: "f(): void", description: "d" })] }),
    );
    expect(clean).toContain("no drift detected");
  });
});

describe("v3.5 drift — end to end over a real source", () => {
  it("detects a signature change with untouched JSDoc", () => {
    const root = fixtureSource(DOCUMENTED);
    const first = extractFromSource({ root });
    const baseline = snapshotOf("1.0.0", first.symbols);

    // Code moves on (param added), docs comment stays identical.
    fs.writeFileSync(
      path.join(root, "index.js"),
      `/**
 * Brew a cup.
 * @param {string} kind - what to brew
 * @returns {string} the cup
 */
export function brew(kind, strength) { return "cup of " + kind + strength; }
`,
      "utf8",
    );
    const second = extractFromSource({ root });
    const report = compareDrift(baseline, {
      title: second.title,
      label: "1.1.0",
      symbols: second.symbols,
    });
    expect(report.stale.map((e) => e.name)).toEqual(["brew"]);
  });

  it("stays clean when the JSDoc is refreshed alongside the code", () => {
    const root = fixtureSource(DOCUMENTED);
    const first = extractFromSource({ root });
    const baseline = snapshotOf("1.0.0", first.symbols);

    fs.writeFileSync(
      path.join(root, "index.js"),
      `/**
 * Brew a cup with strength control.
 * @param {string} kind - what to brew
 * @param {number} strength - how strong
 * @returns {string} the cup
 */
export function brew(kind, strength) { return "cup of " + kind + strength; }
`,
      "utf8",
    );
    const second = extractFromSource({ root });
    const report = compareDrift(baseline, {
      title: second.title,
      label: "1.1.0",
      symbols: second.symbols,
    });
    expect(report.stale).toHaveLength(0);
    expect(report.docsUpdated).toBeGreaterThan(0);
  });

  it("a body-only edit is not drift (implementation, not API)", () => {
    const root = fixtureSource(DOCUMENTED);
    const first = extractFromSource({ root });
    const baseline = snapshotOf("1.0.0", first.symbols);

    fs.writeFileSync(
      path.join(root, "index.js"),
      `/**
 * Brew a cup.
 * @param {string} kind - what to brew
 * @returns {string} the cup
 */
export function brew(kind) { return "FRESH cup of " + kind; }
`,
      "utf8",
    );
    const second = extractFromSource({ root });
    const report = compareDrift(baseline, {
      title: second.title,
      label: "1.1.0",
      symbols: second.symbols,
    });
    expect(report.stale).toHaveLength(0);
    expect(report.entries[0].status).toBe("in-sync");
  });
});
