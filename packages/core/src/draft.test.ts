import { describe, expect, it, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { buildDrafts, applyDrafts, jsdocStub } from "./draft.js";
import type { SymbolDoc } from "./types.js";

function makeProject(files: Record<string, string>): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "brewdocs-draft-"));
  for (const [name, content] of Object.entries(files)) {
    const abs = path.join(root, name);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content, "utf8");
  }
  return root;
}

const INDEX = `export function brew(source: string, strength: number): string {
  return source + strength;
}

export const VERSION = "1.0.0";

export interface Cup {
  size: number;
}
`;

const PKG = JSON.stringify({
  name: "lib",
  version: "1.0.0",
  main: "index.ts",
});

afterEach(() => {
  /* temp dirs are per-test via mkdtemp; nothing to clean synchronously */
});

describe("v1.0.0 — draft", () => {
  it("proposes a stub for every undocumented exported symbol", () => {
    const root = makeProject({ "index.ts": INDEX, "package.json": PKG });
    const proposals = buildDrafts({ root });
    const names = proposals.map((p) => p.symbol);
    expect(names.sort()).toEqual(["Cup", "VERSION", "brew"]);
    // none already have a JSDoc, so all are draftable and live in the entry file
    for (const p of proposals) {
      expect(p.file.endsWith("index.ts")).toBe(true);
      expect(p.kind).toBeTruthy();
    }
  });

  it("skips already-documented symbols", () => {
    const documented = `/**
 * Brew a cup.
 * @param source - repo path
 * @param strength - 1..5
 * @returns the brew
 */
export function brew(source: string, strength: number): string {
  return source + strength;
}
`;
    const root = makeProject({ "index.ts": documented, "package.json": PKG });
    const proposals = buildDrafts({ root });
    expect(proposals.map((p) => p.symbol)).not.toContain("brew");
  });

  it("generates @param and @returns from resolved types", () => {
    const sym: SymbolDoc = {
      name: "brew",
      kind: "function",
      params: [
        { name: "source", type: "string" },
        { name: "strength", type: "number", optional: true },
      ],
      returns: { type: "string" },
      examples: [],
    };
    const stub = jsdocStub(sym);
    expect(stub).toContain("@param {string} source -");
    expect(stub).toContain("@param {number?} strength -");
    expect(stub).toContain("@returns {string} -");
    // description line left empty so coverage is not faked
    expect(stub.split("\n")[1]).toBe(" *");
  });

  it("adds a @deprecated hint via the replacement graph", () => {
    const sym: SymbolDoc = {
      name: "oldBrew",
      kind: "function",
      params: [],
      examples: [],
      deprecated: "use new thing",
      replacements: ["brew"],
    };
    const stub = jsdocStub(sym);
    expect(stub).toContain("@deprecated use `brew` instead");
  });

  it("--fix writes the JSDoc above the declaration", () => {
    const root = makeProject({ "index.ts": INDEX, "package.json": PKG });
    const proposals = buildDrafts({ root });
    const changed = applyDrafts(proposals);
    expect(changed).toHaveLength(1);
    const out = fs.readFileSync(path.join(root, "index.ts"), "utf8");
    expect(out).toContain("/**\n *\n * @param {string} source -");
    expect(out.indexOf("/**")).toBeLessThan(out.indexOf("export function brew"));
    // declaration is still intact after the insert
    expect(out).toContain("export function brew(source: string, strength: number): string {");
  });
});
