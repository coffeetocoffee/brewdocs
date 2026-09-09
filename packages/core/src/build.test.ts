import { describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { build } from "@brewdocs/core";

const TINY = path.resolve(__dirname, "../../../examples/tiny");

describe("BrewDocs build (Phase 0)", () => {
  it("produces a standalone index.html from examples/tiny", () => {
    const out = fs.mkdtempSync(path.join(os.tmpdir(), "brewdocs-"));
    const outFile = build({ root: TINY }, out);
    expect(fs.existsSync(outFile)).toBe(true);

    const html = fs.readFileSync(outFile, "utf8");
    expect(html).toContain("<!doctype html>");
    expect(html).toContain("tiny");
    expect(html).toContain("BrewDocs");
    // README content should be rendered (heading + code block).
    expect(html).toContain("<h1>tiny</h1>");
    expect(html).toContain('<pre class="code"');
  });

  it("falls back to the directory name when package.json is missing", () => {
    const out = fs.mkdtempSync(path.join(os.tmpdir(), "brewdocs-"));
    const outFile = build({ root: path.dirname(TINY) }, out);
    const html = fs.readFileSync(outFile, "utf8");
    expect(html).toContain("BrewDocs");
  });

  it("renders an in-page coverage score chip (brewdocs doctor score)", () => {
    const out = fs.mkdtempSync(path.join(os.tmpdir(), "brewdocs-"));
    const outFile = build({ root: TINY }, out);
    const html = fs.readFileSync(outFile, "utf8");
    expect(html).toContain("coverage-chip");
    expect(html).toMatch(/documented/);
  });

  it("emits accessible markup (skip link, labelled nav, labelled search)", () => {
    const out = fs.mkdtempSync(path.join(os.tmpdir(), "brewdocs-"));
    const outFile = build({ root: TINY }, out);
    const html = fs.readFileSync(outFile, "utf8");
    expect(html).toContain('class="skip-link"');
    expect(html).toContain('id="main-content"');
    expect(html).toContain('aria-label="Table of contents"');
    expect(html).toContain('aria-label="Search documentation"');
  });

  it("emits docmodel.json next to the HTML by default", () => {
    const out = fs.mkdtempSync(path.join(os.tmpdir(), "brewdocs-"));
    build({ root: TINY }, out);
    const jsonFile = path.join(out, "docmodel.json");
    expect(fs.existsSync(jsonFile)).toBe(true);
    const parsed = JSON.parse(fs.readFileSync(jsonFile, "utf8")) as {
      schema: string;
      title: string;
      symbols: unknown[];
    };
    expect(parsed.schema).toBe("brewdocs/docmodel@1");
    expect(parsed.title).toBe("tiny");
    expect(Array.isArray(parsed.symbols)).toBe(true);
  });

  it("skips docmodel.json with emitDocmodel: false", () => {
    const out = fs.mkdtempSync(path.join(os.tmpdir(), "brewdocs-"));
    build({ root: TINY }, out, { emitDocmodel: false });
    expect(fs.existsSync(path.join(out, "docmodel.json"))).toBe(false);
    expect(fs.existsSync(path.join(out, "index.html"))).toBe(true);
  });
});
