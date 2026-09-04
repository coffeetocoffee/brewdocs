import { describe, expect, it } from "vitest";
import { buildModel, renderToHtml, renderToHtmlMulti } from "@brewdocs/core";
import * as fs from "node:fs";
import * as path from "node:path";

const LIB = path.resolve(process.cwd(), "examples/lib");

describe("multi-page rendering", () => {
  it("emits an index plus one page per symbol", () => {
    const model = buildModel({ root: LIB, name: "lib" });
    const pages = renderToHtmlMulti(model, { theme: "coffee" });
    const paths = pages.map((p) => p.path);

    expect(paths).toContain("index.html");
    for (const sym of model.symbols) {
      const slug = sym.name
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-+|-+$/g, "");
      expect(paths).toContain(`symbols/${slug}.html`);
    }
    expect(pages.length).toBe(model.symbols.length + 1);
  });

  it("links the index to symbol pages and keeps the search index pointed at them", () => {
    const model = buildModel({ root: LIB, name: "lib" });
    const pages = renderToHtmlMulti(model, { theme: "coffee" });
    const index = pages.find((p) => p.path === "index.html")!.html;
    const first = model.symbols[0];
    const slug = first.name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "");
    expect(index).toContain(`symbols/${slug}.html`);
    expect(index).toContain(`"url":"symbols/${slug}.html"`);
  });

  it("still renders a single page when multiPage is off", () => {
    const model = buildModel({ root: LIB, name: "lib" });
    const html = renderToHtml(model, { theme: "coffee" });
    expect(html).toContain('id="api"');
    expect(html).not.toContain("symbols/");
  });
});
