import { describe, expect, it } from "vitest";
import { markdownToHtml } from "./markdown.js";
import { renderToHtml } from "./render.js";
import type { RenderModel } from "./types.js";

/**
 * v3.9 finding #17: the renderer emits its own CSS/JS and had no golden-output
 * test, which is how the attribute-injection XSS (#3) survived 311 green tests.
 * This locks the whole page for one deterministic model, including a hostile
 * link/description so an escaping regression fails the snapshot loudly.
 *
 * Kept free of timestamps (no `freshness`, no sourceFile) so it is stable.
 */
const HOSTILE: RenderModel = {
  title: "golden",
  description: "Golden output model",
  frontmatter: {},
  metadata: {},
  sections: [
    {
      id: "intro",
      title: "Intro",
      level: 2,
      // A hostile link target and a hostile image are both untrusted prose.
      html: markdownToHtml(
        '# Intro\n\nHello **world**.\n\n[link](x"onmouseover="alert(1)//)\n\n![i](x"onerror="alert(1)//)',
      ),
    },
  ],
  symbols: [
    {
      name: "brew",
      kind: "function",
      signature: 'export function brew(x: string): void {}',
      description: 'Brew it "with quotes" <script>alert(1)</script>.',
      params: [
        { name: "x", type: "string", description: 'the "x" value', optional: false },
      ],
      returns: { type: "void", description: "nothing" },
      examples: ["brew('a\"b');"],
    },
  ],
};

describe("Golden output", () => {
  it("renders the full page deterministically", () => {
    const html = renderToHtml(HOSTILE);
    // The escape contract (INV-4) must hold in attributes too: no live handler.
    expect(html).not.toContain('onmouseover="alert');
    expect(html).not.toContain('onerror="alert');
    expect(html).toMatchSnapshot();
  });
});
