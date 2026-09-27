import { describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
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

  it("ignores # lines inside fenced code blocks (bash/python comments)", () => {
    const md = [
      "# API",
      "",
      "```bash",
      "curl http://localhost:4000/api/build",
      '# => {"url":"https://lib.brewdocs.dev","subdomain":"lib"}',
      "```",
      "",
      "## Next",
      "done",
    ].join("\n");
    const r = extractReadme(md);
    expect(r.sections.map((s) => s.title)).toEqual(["API", "Next"]);
    // The comment stays inside the code block, not as a heading.
    const api = r.sections[0];
    expect(api.html).toContain("lib.brewdocs.dev");
    expect(api.html).not.toContain("<h2>");
  });

  it("exports extractor resolves entry from a class-only package", () => {
    const syms = extractExports(path.join(EXAMPLES, "widget"), {
      main: "index.ts",
    });
    expect(syms.some((s) => s.name === "Widget" && s.kind === "class")).toBe(true);
  });
});

describe("v3.10 — TypeScript depth", () => {
  function fixture(): string {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "brewdocs-ts-"));
    fs.mkdirSync(path.join(root, "src"));
    fs.writeFileSync(
      path.join(root, "src/index.ts"),
      [
        "/** Status of a brew. */",
        "export enum Status {",
        "  /** Not started. */",
        '  Idle = "idle",',
        "  Brewing = 1,",
        "}",
        "",
        "/** Brewing helpers. */",
        "export namespace Util {",
        '  export const version = "1";',
        "}",
        "",
        "/** A service. */",
        "@Injectable()",
        "export class Service {",
        "  /** Starts it. */",
        "  start(): void {}",
        "}",
        "",
      ].join("\n"),
    );
    fs.writeFileSync(
      path.join(root, "src/server.ts"),
      [
        "/** Server options. */",
        "export interface ServerOptions {",
        "  /** Listen port. */",
        "  port: number;",
        "}",
        "",
      ].join("\n"),
    );
    return root;
  }

  const pkg = {
    exports: { ".": "./src/index.ts", "./server": "./src/server.ts" },
  };

  it("classifies enums and namespaces (not 'unknown')", () => {
    const syms = extractExports(fixture(), pkg);
    expect(syms.find((s) => s.name === "Status")?.kind).toBe("enum");
    expect(syms.find((s) => s.name === "Util")?.kind).toBe("namespace");
  });

  it("extracts enum members with values and docs", () => {
    const status = extractExports(fixture(), pkg).find((s) => s.name === "Status");
    const idle = status?.members?.find((m) => m.name === "Idle");
    expect(idle?.kind).toBe("enumMember");
    expect(idle?.signature).toBe('Idle = "idle"');
    expect(idle?.description).toBe("Not started.");
    expect(status?.members?.find((m) => m.name === "Brewing")?.signature).toBe(
      "Brewing = 1",
    );
  });

  it("captures decorators as Name(...)", () => {
    const service = extractExports(fixture(), pkg).find((s) => s.name === "Service");
    expect(service?.decorators).toEqual(["Injectable(...)"]);
  });

  it("walks subpath exports, not just '.'", () => {
    const syms = extractExports(fixture(), pkg);
    const opts = syms.find((s) => s.name === "ServerOptions");
    expect(opts?.kind).toBe("interface");
    expect(opts?.sourceFile).toBe(path.join("src", "server.ts"));
  });
});
