import { describe, expect, it } from "vitest";
import * as path from "node:path";
import { buildModel, extractExports, extractReadme } from "@brewdocs/core";

const EXAMPLES = path.resolve(__dirname, "../../../examples");

describe("Phase 1 extractors", () => {
  it("lib: extracts JSDoc-documented exports", () => {
    const model = buildModel({ root: path.join(EXAMPLES, "lib") });

    expect(model.title).toBe("lib");
    expect(model.symbols.map((s) => s.name).sort()).toEqual([
      "Cup",
      "VERSION",
      "brew",
      "oldBrew",
      "pour",
    ]);
    expect(model.symbols.find((s) => s.name === "brew")?.params).toEqual([
      { name: "source", type: "string", description: "repo or package path to brew from", optional: false },
      {
        name: "strength",
        type: "number",
        description: "how strong the brew is, from 1 (weak) to 5 (bold)",
        optional: false,
      },
    ]);
    const deprecated = model.symbols.find((s) => s.name === "oldBrew");
    expect(deprecated?.deprecated).toBeTruthy();
    expect(deprecated?.deprecated).toContain("brew");
    const pour = model.symbols.find((s) => s.name === "pour");
    expect(pour?.returns?.description).toContain("cup descriptor");

    expect(model).toMatchSnapshot();
  });

  it("widget: extracts multiple symbol kinds without JSDoc", () => {
    const model = buildModel({ root: path.join(EXAMPLES, "widget") });
    const kinds = Object.fromEntries(
      model.symbols.map((s) => [s.name, s.kind]),
    );
    expect(kinds).toEqual({
      SIZE_SM: "constant",
      SIZE_LG: "constant",
      WidgetOptions: "interface",
      Widget: "class",
    });
    expect(model).toMatchSnapshot();
  });

  it("tiny: no exports, README parsed into sections with frontmatter", () => {
    const model = buildModel({ root: path.join(EXAMPLES, "tiny") });
    expect(model.symbols).toEqual([]);
    expect(model.sections.length).toBeGreaterThan(0);
    expect(model).toMatchSnapshot();
  });

  it("README frontmatter + sections parse independently", () => {
    const md = `---\ntitle: X\nsummary: hi\n---\n# Heading\nbody text\n## Sub\nmore\n`;
    const r = extractReadme(md);
    expect(r.frontmatter).toEqual({ title: "X", summary: "hi" });
    expect(r.sections.map((s) => s.title)).toEqual(["Heading", "Sub"]);
  });

  it("exports extractor resolves entry from a class-only package", () => {
    const syms = extractExports(path.join(EXAMPLES, "widget"), {
      main: "index.ts",
    });
    expect(syms.some((s) => s.name === "Widget" && s.kind === "class")).toBe(true);
  });
});
