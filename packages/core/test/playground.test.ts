import { describe, expect, it } from "vitest";
import { renderToHtml, renderToHtmlMulti, type RenderModel } from "@brewdocs/core";

function model(): RenderModel {
  return {
    title: "pg",
    description: "playground demo",
    frontmatter: {},
    sections: [],
    metadata: {},
    symbols: [
      {
        name: "add",
        kind: "function",
        signature: "add(a: number, b: number): number",
        description: "Add two numbers.",
        params: [
          { name: "a", type: "number" },
          { name: "b", type: "number" },
        ],
        returns: { type: "number" },
        examples: ["console.log(add(2, 3));"],
      },
      {
        name: "VERSION",
        kind: "constant",
        description: "Current version.",
        params: [],
        examples: [],
      },
    ],
  };
}

describe("v2.5 interactive playground", () => {
  it("stays off by default (no runner DOM or script)", () => {
    const html = renderToHtml(model());
    expect(html).not.toContain("class=\"playground\"");
    expect(html).not.toContain("sourceURL=playground");
  });

  it("renders an editable runner under each example when enabled", () => {
    const html = renderToHtml(model(), { playground: true });
    expect(html).toContain("class=\"playground\"");
    expect(html).toContain("console.log(add(2, 3));");
    expect(html).toContain("pg-run");
    expect(html).toContain("sourceURL=playground");
    // Only the symbol with examples gets a playground block.
    const blocks = html.match(/class="playground"/g) ?? [];
    expect(blocks.length).toBe(1);
  });

  it("escapes example code so it cannot break the textarea", () => {
    const m = model();
    m.symbols[0].examples = ["console.log(\"</textarea><script>alert(1)</script>\");"];
    const html = renderToHtml(m, { playground: true });
    expect(html).not.toContain("</textarea><script>");
    expect(html).toContain("&lt;/textarea&gt;");
  });

  it("works on multi-page symbol pages too", () => {
    const pages = renderToHtmlMulti(model(), { playground: true });
    const sym = pages.find((p) => p.path === "symbols/add.html");
    expect(sym?.html).toContain("class=\"playground\"");
    const index = pages.find((p) => p.path === "index.html");
    expect(index?.html).not.toContain("class=\"playground\"");
  });
});
