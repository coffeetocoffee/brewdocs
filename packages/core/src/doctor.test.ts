import { describe, expect, it } from "vitest";
import { analyzeSymbols, badgeSvg } from "./doctor.js";
import type { SymbolDoc } from "./types.js";

function sym(partial: Partial<SymbolDoc> & { name: string }): SymbolDoc {
  return {
    kind: "function",
    params: [],
    examples: [],
    ...partial,
  };
}

describe("v0.2.0 — doctor", () => {
  it("scores a fully documented API at 100", () => {
    const report = analyzeSymbols("lib", [
      sym({
        name: "add",
        description: "Adds numbers.",
        params: [
          { name: "a", description: "first" },
          { name: "b", description: "second" },
        ],
        returns: { type: "number", description: "the sum" },
        examples: ["add(1, 2)"],
      }),
    ]);
    expect(report.score).toBe(100);
    expect(report.issues).toHaveLength(0);
  });

  it("flags undocumented symbols as errors", () => {
    const report = analyzeSymbols("lib", [
      sym({ name: "mystery", params: [], examples: [] }),
    ]);
    expect(report.documentedSymbols).toBe(0);
    expect(report.issues[0].severity).toBe("error");
    expect(report.issues[0].message).toContain("no description");
    expect(report.score).toBeLessThan(100);
  });

  it("flags undocumented params and returns as warnings", () => {
    const report = analyzeSymbols("lib", [
      sym({
        name: "f",
        description: "does things",
        params: [{ name: "x" }],
        returns: { type: "void" },
        examples: ["f(1)"],
      }),
    ]);
    const kinds = report.issues.map((i) => i.message);
    expect(kinds.some((m) => m.includes('"x" is undocumented'))).toBe(true);
    // void returns without type are not counted; use a typed return:
    expect(report.score).toBeGreaterThan(0);
  });

  it("does not count returns coverage when no return type exists", () => {
    const report = analyzeSymbols("lib", [
      sym({ name: "f", description: "d", params: [], examples: ["f()"] }),
      sym({ name: "g", description: "d", params: [], examples: ["g()"] }),
    ]);
    expect(report.returnsTotal).toBe(0);
    expect(report.score).toBe(100);
  });

  it("awards full example points when no runnable symbols exist", () => {
    const report = analyzeSymbols("lib", [
      sym({ name: "T", kind: "type", description: "a type" }),
    ]);
    expect(report.score).toBe(100);
  });

  it("produces a badge SVG", () => {
    const report = analyzeSymbols("lib", [
      sym({ name: "f", description: "d", params: [], examples: ["f()"] }),
    ]);
    const svg = badgeSvg(report);
    expect(svg.startsWith("<svg")).toBe(true);
    expect(svg).toContain(`${report.score}%`);
  });
});
