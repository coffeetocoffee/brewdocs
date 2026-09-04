import { describe, expect, it } from "vitest";
import { diffSymbols, renderDiffHtml } from "./diff.js";
import type { SymbolDoc } from "./types.js";

function sym(partial: Partial<SymbolDoc> & { name: string }): SymbolDoc {
  return {
    kind: "function",
    params: [],
    examples: [],
    ...partial,
  };
}

describe("v0.2.0 — diff", () => {
  it("detects added and removed symbols", () => {
    const diff = diffSymbols(
      "1.0.0",
      [sym({ name: "old", signature: "old(): void" })],
      "2.0.0",
      [sym({ name: "fresh", signature: "fresh(): void" })],
    );
    expect(diff.added.map((c) => c.name)).toEqual(["fresh"]);
    expect(diff.removed.map((c) => c.name)).toEqual(["old"]);
    expect(diff.breakingCount).toBe(1);
    expect(diff.summary).toContain("1 breaking");
  });

  it("detects signature changes as breaking", () => {
    const diff = diffSymbols(
      "1.0.0",
      [sym({ name: "f", signature: "f(a: string): void" })],
      "2.0.0",
      [sym({ name: "f", signature: "f(a: string, b: number): void" })],
    );
    expect(diff.changed).toHaveLength(1);
    expect(diff.changed[0].breaking).toBe(true);
    expect(diff.changed[0].changes).toContain("signature-changed");
  });

  it("ignores whitespace-only signature differences", () => {
    const diff = diffSymbols(
      "1.0.0",
      [sym({ name: "f", signature: "f( a:string ):{void}" })],
      "2.0.0",
      [sym({ name: "f", signature: "f(  a:string  ):{void}" })],
    );
    expect(diff.changed).toHaveLength(0);
  });

  it("detects deprecation transitions without breaking", () => {
    const diff = diffSymbols(
      "1.0.0",
      [sym({ name: "f", signature: "f(): void" })],
      "2.0.0",
      [sym({ name: "f", signature: "f(): void", deprecated: "use g" })],
    );
    expect(diff.changed[0].changes).toContain("deprecated");
    expect(diff.changed[0].breaking).toBe(false);
  });

  it("detects docs-only changes without breaking", () => {
    const diff = diffSymbols(
      "1.0.0",
      [sym({ name: "f", signature: "f(): void", description: "old docs" })],
      "2.0.0",
      [sym({ name: "f", signature: "f(): void", description: "new docs" })],
    );
    expect(diff.changed[0].changes).toContain("docs-changed");
    expect(diff.breakingCount).toBe(0);
  });

  it("detects kind changes as breaking", () => {
    const diff = diffSymbols(
      "1.0.0",
      [sym({ name: "x", kind: "constant" })],
      "2.0.0",
      [sym({ name: "x", kind: "function", signature: "x()" })],
    );
    expect(diff.changed[0].changes).toContain("kind-changed");
    expect(diff.changed[0].breaking).toBe(true);
  });

  it("reports no changes for identical APIs", () => {
    const symbols = [sym({ name: "f", signature: "f(): void", description: "d" })];
    const diff = diffSymbols("1.0.0", symbols, "1.0.1", symbols);
    expect(diff.summary).toBe("No API changes detected.");
  });

  it("renders a standalone HTML page", () => {
    const diff = diffSymbols(
      "1.0.0",
      [sym({ name: "gone", signature: "gone(): void" })],
      "2.0.0",
      [sym({ name: "new", signature: "new(): void" })],
    );
    const html = renderDiffHtml(diff, "widget");
    expect(html).toContain("<!doctype html>");
    expect(html).toContain("widget");
    expect(html).toContain("v1.0.0");
    expect(html).toContain("v2.0.0");
    expect(html).toContain("gone");
    expect(html).toContain("new");
    expect(html).toContain("BREAKING");
  });
});
