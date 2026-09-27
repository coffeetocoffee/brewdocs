import { describe, expect, it } from "vitest";
import {
  listLocales,
  normalizeLocale,
  renderToHtml,
  uiStrings,
  type RenderModel,
} from "@brewdocs/core";

const model: RenderModel = {
  title: "lib",
  description: "A test lib.",
  frontmatter: {},
  sections: [],
  metadata: {},
  symbols: [
    {
      name: "greet",
      kind: "function",
      signature: "function greet(name: string): string",
      description: "Greet.",
      params: [{ name: "name", type: "string", description: "who" }],
      returns: { type: "string", description: "greeting" },
      examples: [],
      deprecated: true,
    },
  ],
};

describe("v3.0 i18n", () => {
  it("normalizes locale codes with English fallback", () => {
    expect(normalizeLocale("id-ID")).toBe("id");
    expect(normalizeLocale("DE")).toBe("de");
    expect(normalizeLocale("zz")).toBe("en");
    expect(normalizeLocale(undefined)).toBe("en");
  });

  it("merges partial dictionaries over English", () => {
    const id = uiStrings("id");
    expect(id.parameters).toBe("Parameter");
    expect(id.eolBanner).toBe("Versi ini tidak lagi dipelihara.");
    // untranslated keys fall back to English
    expect(id.api).toBe("API");
    const en = uiStrings(undefined);
    expect(en.backToDocs).toBe("Back to docs");
  });

  it("lists bundled locales", () => {
    const codes = listLocales().map((l) => l.code);
    expect(codes).toContain("en");
    expect(codes).toContain("id");
    expect(codes.length).toBeGreaterThanOrEqual(4);
  });

  it("renders localized chrome and <html lang>", () => {
    const html = renderToHtml(model, { locale: "ja" });
    expect(html).toContain('<html lang="ja"');
    expect(html).toContain("パラメータ");
    expect(html).toContain("戻り値");
    expect(html).toContain("非推奨");
    // English default untouched
    const en = renderToHtml(model);
    expect(en).toContain('<html lang="en"');
    expect(en).toContain("<h4>Parameters</h4>");
  });

  it("keeps doc content untranslated", () => {
    const html = renderToHtml(model, { locale: "de" });
    expect(html).toContain("A test lib.");
    expect(html).toContain("who");
  });
});

describe("v3.0 SEO meta (audit suite groundwork)", () => {
  it("emits description, og and generator meta tags", () => {
    const html = renderToHtml(model, { dark: true });
    expect(html).toContain('<meta name="description" content="A test lib."');
    expect(html).toContain('<meta property="og:title"');
    expect(html).toContain('<meta property="og:type" content="article"');
    expect(html).toContain('<meta name="generator" content="brewdocs"');
    expect(html).toContain('<meta name="theme-color"');
  });

  it("guards smooth scroll behind prefers-reduced-motion", () => {
    const html = renderToHtml(model);
    expect(html).toContain("prefers-reduced-motion: no-preference");
  });
});
