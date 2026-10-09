import { describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { markdownToHtml } from "../src/markdown.js";
import { renderToHtml } from "../src/render.js";
import type { RenderModel } from "../src/types.js";

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

  /**
   * Finding #32: the snapshot above calls renderToHtml with NO options, so
   * theme.css is undefined and themeVars gets a built-in — the whole CSS
   * emission path (and the manifest that feeds it) was never covered. That gap
   * is why a repo-shipped manifest could inject through slots unnoticed.
   *
   * This case pins the themed page: a manifest's vars and css reach the output,
   * and both stay inside the single <style> element (INV-30). Slots are
   * materialized by resolveSetup (build.ts), so they are covered by
   * theme-provenance.test.ts and hostile.test.ts instead.
   *
   * The manifest uses the documented inline-value YAML subset (the reader does
   * not implement block scalars).
   */
  it("renders a themed page with a manifest, and pins the style channel", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "bd-golden-theme-"));
    fs.mkdirSync(path.join(root, "themes"), { recursive: true });
    fs.writeFileSync(
      path.join(root, "themes", "golden.yml"),
      [
        "base: ink",
        "vars:",
        "  accent: '#123456'",
        'css: ".golden-marker { border: 1px solid red; }"',
      ].join("\n"),
      "utf8",
    );

    const html = renderToHtml(HOSTILE, { theme: "golden", root });

    expect(html).toContain("--accent: #123456");
    expect(html).toContain(".golden-marker");
    // The style channel stays one element (INV-30) even with a manifest.
    expect((html.match(/<style\b/gi) ?? []).length).toBe(1);
    expect((html.match(/<\/style>/gi) ?? []).length).toBe(1);
    expect(html).toMatchSnapshot();
  });
});
