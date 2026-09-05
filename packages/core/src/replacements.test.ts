import { describe, expect, it } from "vitest";
import { resolveReplacements, replacementHint } from "./replacements.js";
import { extractFromSource } from "./extract.js";
import { buildDocModel } from "./docmodel.js";
import type { SymbolDoc } from "./types.js";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

function sym(partial: Partial<SymbolDoc> & { name: string }): SymbolDoc {
  return { kind: "function", params: [], examples: [], ...partial };
}

const EXAMPLES = path.resolve(__dirname, "../../../examples");
const libRoot = path.join(EXAMPLES, "lib");

describe("Direction C — deprecation → replacement graph", () => {
  it("links a deprecated symbol to a @see successor", () => {
    const symbols = [
      sym({ name: "oldThing", deprecated: "Use newThing instead.", see: ["newThing"] }),
      sym({ name: "newThing" }),
    ];
    expect(resolveReplacements(symbols)).toEqual({ oldThing: ["newThing"] });
  });

  it("resolves successors from the deprecated note prose", () => {
    const symbols = [
      sym({ name: "parse", deprecated: "use parseSafe instead" }),
      sym({ name: "parseSafe" }),
    ];
    expect(resolveReplacements(symbols)).toEqual({ parse: ["parseSafe"] });
  });

  it("ignores prose words and unknown identifiers", () => {
    const symbols = [
      sym({ name: "old", deprecated: "This is unsafe, use something better soon." }),
      sym({ name: "helper" }),
    ];
    expect(resolveReplacements(symbols)).toEqual({});
  });

  it("never points at itself", () => {
    const symbols = [
      sym({ name: "loop", deprecated: "loop is deprecated, see loop2" }),
      sym({ name: "loop2" }),
    ];
    expect(resolveReplacements(symbols)).toEqual({ loop: ["loop2"] });
  });

  it("skips non-deprecated symbols entirely", () => {
    const symbols = [sym({ name: "fine", see: ["other"] }), sym({ name: "other" })];
    expect(resolveReplacements(symbols)).toEqual({});
  });

  it("replacementHint renders the 'use X instead' phrase", () => {
    expect(replacementHint(["a", "b"])).toBe("use `a` or `b` instead");
    expect(replacementHint(undefined)).toBe("");
    expect(replacementHint([])).toBe("");
  });

  it("extraction populates replacements from the lib fixture ({@link brew})", () => {
    const result = extractFromSource({ root: libRoot, name: "lib" });
    const oldBrew = result.symbols.find((s) => s.name === "oldBrew");
    expect(oldBrew?.deprecated).toBeTruthy();
    expect(oldBrew?.replacements).toEqual(["brew"]);
    // Non-deprecated symbols stay clean.
    expect(result.symbols.find((s) => s.name === "brew")?.replacements).toBeUndefined();
  });
});

describe("Direction C — dogfood: docmodel.json as a CI-bot consumer input", () => {
  it("a bot reads the artifact and answers API questions without the source", () => {
    const out = fs.mkdtempSync(path.join(os.tmpdir(), "brewdocs-dogfood-"));
    try {
      const file = buildDocModel({ root: libRoot, name: "lib" }, out);
      const artifact = JSON.parse(fs.readFileSync(file, "utf8")) as {
        schema: string;
        version?: string;
        symbols: Array<{
          name: string;
          kind: string;
          params: Array<{ name: string; type?: string }>;
          deprecated?: unknown;
          replacements?: string[];
        }>;
      };

      // 1. "What does this package export?"
      expect(artifact.symbols.map((s) => s.name)).toContain("brew");
      // 2. "What are the parameters of brew?"
      const brew = artifact.symbols.find((s) => s.name === "brew")!;
      expect(brew.kind).toBe("function");
      expect(brew.params.map((p) => p.name)).toEqual(["source", "strength"]);
      // 3. "Is anything deprecated, and what replaces it?"
      const deprecated = artifact.symbols.filter((s) => s.deprecated);
      expect(deprecated.map((s) => s.name)).toContain("oldBrew");
      for (const s of deprecated) {
        expect(Array.isArray(s.replacements)).toBe(true);
        expect(s.replacements!.length).toBeGreaterThan(0);
      }
      // 4. Freshness: a bot can decide whether its cache is stale.
      expect(artifact.schema).toBe("brewdocs/docmodel@1");
      expect(artifact.version).toBe("1.2.0");
    } finally {
      fs.rmSync(out, { recursive: true, force: true });
    }
  });
});
