import { describe, expect, it } from "vitest";
import { getTheme, listThemes } from "./themes.js";
import { highlightCode } from "./highlight.js";
import { markdownToHtml } from "./markdown.js";
import { renderToHtml } from "./render.js";
import type { RenderModel } from "./types.js";

const baseModel: RenderModel = {
  title: "demo",
  description: "A demo",
  frontmatter: {},
  sections: [
    {
      id: "intro",
      title: "Intro",
      level: 2,
      html: markdownToHtml("# Intro\n\nHello **world**."),
    },
  ],
  metadata: {},
  symbols: [
    {
      name: "brew",
      kind: "function",
      signature: "export function brew(): void {}",
      description: "Brew it.",
      params: [{ name: "x", type: "string", description: "x", optional: false }],
      examples: ['brew();'],
    },
  ],
};

describe("Phase 2 — themes", () => {
  it("ships multiple non-default themes", () => {
    expect(listThemes().map((t) => t.name).sort()).toEqual([
      "coffee",
      "ink",
      "matcha",
      "newsprint",
    ]);
  });

  it("themes differ in accent color", () => {
    expect(getTheme("matcha").light["--accent"]).not.toBe(
      getTheme("coffee").light["--accent"],
    );
  });

  it("falls back to default for unknown theme", () => {
    expect(getTheme("nope").name).toBe("coffee");
  });
});

describe("Phase 2 — highlighter", () => {
  it("wraps keywords and numbers", () => {
    const html = highlightCode("const x = 42;", "ts");
    expect(html).toContain('class="tok-keyword"');
    expect(html).toContain('class="tok-number"');
  });

  it("escapes HTML in code", () => {
    const html = highlightCode("const a = '<b>';", "ts");
    expect(html).toContain("&lt;b&gt;");
  });
});

describe("Phase 2 — markdown", () => {
  it("renders headings, bold, lists, tables, blockquotes, links", () => {
    const md = `# Title

Some **bold** and a [link](https://x.dev).

- one
- two

> a quote

| A | B |
| - | - |
| 1 | 2 |
`;
    const html = markdownToHtml(md);
    expect(html).toContain("<h1>Title</h1>");
    expect(html).toContain("<strong>bold</strong>");
    expect(html).toContain('<a href="https://x.dev">link</a>');
    expect(html).toContain("<ul><li>one</li><li>two</li></ul>");
    expect(html).toContain("<blockquote>");
    expect(html).toContain("<table>");
  });
});

describe("Phase 2 — render + theming", () => {
  it("includes theme variables and a dark-mode toggle", () => {
    const html = renderToHtml(baseModel);
    expect(html).toContain("--accent:");
    expect(html).toContain('id="theme-toggle"');
    expect(html).toContain("localStorage.setItem(\"brewdocs-theme\"");
    expect(html).toContain('data-theme="light"');
  });

  it("honors --dark option", () => {
    const html = renderToHtml(baseModel, { dark: true });
    expect(html).toContain('data-theme="dark"');
  });

  it("applies the selected theme accent", () => {
    const html = renderToHtml(baseModel, { theme: "matcha" });
    expect(html).toContain(getTheme("matcha").light["--accent"] ?? "x");
  });

  it("renders highlighted symbol signatures", () => {
    const html = renderToHtml(baseModel);
    expect(html).toContain('class="code sig"');
    expect(html).toContain('class="tok-keyword"');
  });
});
