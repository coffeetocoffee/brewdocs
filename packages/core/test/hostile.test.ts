import { describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { markdownToHtml, renderToHtml, getTheme, type RenderModel } from "@brewdocs/core";

/**
 * v4.6 (finding #27): property tests for adversarial input across markdownToHtml
 * and renderToHtml. Replaces the superficial substrings check in the old fuzz suite
 * with structural invariants verified against a fixed corpus, a seeded generator,
 * and a hostile theme manifest fixture.
 *
 * Deterministic: fixed seed, no clocks, no network.
 */

const MD_TAGS = new Set([
  "h1", "h2", "h3", "h4", "h5", "h6", "p", "pre", "code", "table", "thead",
  "tbody", "tr", "th", "td", "ul", "ol", "li", "blockquote", "hr", "img", "a",
  "strong", "em", "del", "span",
]);

const EXECUTABLE_SCHEME = /^\s*(javascript|vbscript|data):/i;

function markupViolations(html: string, allow: Set<string>): string[] {
  const problems: string[] = [];
  const tagRe = /<\/?([A-Za-z][A-Za-z0-9-]*)((?:[^>"']|"[^"]*"|'[^']*')*)>/g;
  let text = "";
  let last = 0;
  for (const m of html.matchAll(tagRe)) {
    const full = m[0];
    const name = m[1]?.toLowerCase() ?? "";
    const attrs = m[2] ?? "";
    text += html.slice(last, m.index ?? 0);
    last = (m.index ?? 0) + full.length;
    if (full.startsWith("</")) continue;
    if (!allow.has(name)) problems.push(`tag <${name}> not allowed`);
    for (const a of attrs.matchAll(/([A-Za-z][\w-]*)(?:\s*=\s*("[^"]*"|'[^']*'|[^\s"'>]+))?/g)) {
      const attr = (a[1] ?? "").toLowerCase();
      if (/^on/.test(attr)) problems.push(`handler ${attr}=`);
      const val = (a[2] ?? "").replace(/^["']|["']$/g, "").replace(/[\u0000-\u001f\u007f]/g, "").trim();
      if ((attr === "href" || attr === "src" || attr === "action") && EXECUTABLE_SCHEME.test(val)) {
        problems.push(`${attr}="${val.slice(0, 40)}"`);
      }
    }
  }
  text += html.slice(last);
  const rawText = text.replace(/<!doctype[^>]*>/gi, "");
  if (/[<>]/.test(rawText)) {
    const snippet = (rawText.match(/.{0,25}[<>].{0,25}/)?.[0] ?? "").trim();
    problems.push(`raw angle bracket in text: ${snippet}`);
  }
  return problems;
}

const CORPUS = [
  "<script>alert(1)</script>",
  "```\n</script><script>alert(1)</script>\n```",
  "`<script>alert(1)</script>`",
  '![i](x"onerror="alert(1)//)',
  "[x](javascript:alert(1))",
  "[x](vbscript:msgbox(1))",
  "[x](data:text/html,<script>alert(1)</script>)",
  "<img src=x onerror=alert(1)>",
  "# <script>alert(1)</script>",
  "| a | b |\n| --- | --- |\n| <script>x</script> | y |",
  "> <script>alert(1)</script>",
  "- <script>alert(1)</script>",
  '```ts\nconst s = "</script>";\n```',
  "``` ts\n</style><script>alert(1)</script>\n```",
  "</title><script>alert(1)</script>",
  "<style>body{background:url(javascript:alert(1))}</style>",
  '[a](x"onmouseover="alert(1)//)',
  "![](javascript:alert(1))",
  "**</strong><script>alert(1)</script>**",
  "1. <script>alert(1)</script>",
  "---\n<script>alert(1)</script>",
  "&lt;script&gt;alert(1)&lt;/script&gt;",
  "\u0000<script>alert(1)</script>",
];

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const TOKENS = [
  "<", ">", '"', "'", "/", "script", "style", "iframe", "onerror=", "onmouseover=",
  "javascript:", "vbscript:", "data:", "img", "svg", "!", "[", "]", "(", ")", "`",
  "|", "#", "```", "\\", "\n", "&", ";", "=", "alert(1)", "</style>", "</script>",
  "<script>", "&#106;avascript:",
];

function createModel(
  f: (i: number) => { name: string; desc: string; sig: string; ex: string; title: string },
): RenderModel {
  const secs = [0, 1].map((i) => {
    const v = f(i);
    return { id: `sec-${i}`, title: v.title, level: 2, html: markdownToHtml(v.desc) };
  });
  const syms = [0, 1].map((i) => {
    const v = f(i);
    return {
      name: v.name,
      kind: "function" as const,
      signature: v.sig,
      description: v.desc,
      params: [{ name: "p", type: "string", description: v.desc, optional: false }],
      returns: { type: "void", description: v.desc },
      examples: [v.ex],
    };
  });
  const v0 = f(0);
  return {
    title: v0.title,
    description: v0.desc,
    frontmatter: {},
    metadata: {},
    sections: secs,
    symbols: syms,
  };
}

describe("v4.5.6 — hostile input cannot inject live markup", () => {
  it("markdownToHtml: fixed corpus never produces live script, handlers, or unsafe schemes", () => {
    for (const src of CORPUS) {
      const out = markdownToHtml(src);
      const bad = markupViolations(out, MD_TAGS);
      expect(bad, `input: ${JSON.stringify(src)}`).toEqual([]);
      expect(out).not.toMatch(/<script/i);
    }
  });

  it("markdownToHtml: 400 seeded generated documents hold the same properties", () => {
    const rnd = mulberry32(0xc0ffee);
    for (let n = 0; n < 400; n++) {
      const len = 1 + Math.floor(rnd() * 12);
      let s = "";
      for (let k = 0; k < len; k++) s += TOKENS[Math.floor(rnd() * TOKENS.length)];
      let out: string;
      try {
        out = markdownToHtml(s);
      } catch (err) {
        throw new Error(`case ${n} threw on ${JSON.stringify(s)}: ${String(err)}`);
      }
      const bad = markupViolations(out, MD_TAGS);
      expect(bad, `case ${n}: ${JSON.stringify(s)} => ${out}`).toEqual([]);
      expect(out).not.toMatch(/<script/i);
    }
  });

  it("renderToHtml: hostile model cannot add executable handlers or script tags", () => {
    const benign = createModel((i) => ({
      name: `fn${i}`,
      desc: `safe text ${i}`,
      sig: `export function fn${i}(x: string): void`,
      ex: `fn${i}("ok")`,
      title: `Section ${i}`,
    }));
    const hostile = createModel((i) => ({
      name: `fn${i}"><script>alert(1)</script>`,
      desc: `</p><script>alert(1)</script><img src=x onerror=alert(1)>`,
      sig: `export function fn${i}(x: string) { return "</script><script>alert(1)</script>"; }`,
      ex: `const s = "</style><script>alert(1)</script>";`,
      title: `</title><script>alert(1)</script>`,
    }));

    const htmlB = renderToHtml(benign);
    const htmlH = renderToHtml(hostile);

    const maskRawText = (h: string) =>
      h.replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi, "<$1></$1>");

    // Tags inside benign output define the document's tag vocabulary
    const tagNames = new Set(
      [...maskRawText(htmlB).matchAll(/<([A-Za-z][A-Za-z0-9-]*)/g)].map((m) =>
        m[1].toLowerCase(),
      ),
    );

    const bad = markupViolations(maskRawText(htmlH), tagNames);
    expect(bad).toEqual([]);

    // The script tags in hostile must not outnumber benign (no injected script elements)
    const countScripts = (h: string) => (h.match(/<script\b/gi) ?? []).length;
    expect(countScripts(htmlH)).toBe(countScripts(htmlB));

    // The search-index island must remain parseable JSON and carry no unescaped '<'
    const island = /<script id="search-index" type="application\/json">([\s\S]*?)<\/script>/.exec(
      htmlH,
    );
    expect(island).not.toBeNull();
    expect(() => JSON.parse(island![1])).not.toThrow();
    expect(island![1]).not.toContain("<");
  });

  it("renderToHtml: hostile theme manifest cannot break out of <style> (finding #27)", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "bd-hostile-theme-"));
    fs.mkdirSync(path.join(root, "themes"), { recursive: true });
    fs.writeFileSync(
      path.join(root, "themes", "evil.yml"),
      'base: coffee\nvars:\n  accent: "</style><script>alert(1)</script><style>"\ncss: "</style><script>alert(2)</script><style>"\n',
      "utf8",
    );

    const model = createModel((i) => ({
      name: `fn${i}`,
      desc: `safe text ${i}`,
      sig: `export function fn${i}(): void`,
      ex: `fn${i}()`,
      title: `Section ${i}`,
    }));

    const html = renderToHtml(model, { theme: "evil", root });

    // Injected script must not appear outside <style>
    const withoutStyles = html.replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, "");
    expect(withoutStyles).not.toContain("<script>alert(1)");
    expect(withoutStyles).not.toContain("<script>alert(2)");

    // Raw <style> count must equal 1 (the single intended block)
    const styleCount = (html.match(/<style\b/gi) ?? []).length;
    const styleCloseCount = (html.match(/<\/style>/gi) ?? []).length;
    expect(styleCount).toBe(1);
    expect(styleCloseCount).toBe(1);
  });

  /**
   * Finding #32: INV-30 closed the *style* channel, but a manifest's `slots`
   * are interpolated verbatim (raw HTML is the feature), and a bare built-in
   * name resolved to a repo file — so a repo shipping themes/ink.yml hijacked
   * `--theme ink` and got its slot HTML into the published page. The rule is
   * provenance (who may choose the manifest), not escaping, so this asserts
   * that a built-in name never picks up a repo file.
   */
  it("renderToHtml: a repo manifest cannot hijack a built-in theme name (finding #32)", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "bd-shadow-theme-"));
    fs.mkdirSync(path.join(root, "themes"), { recursive: true });
    fs.writeFileSync(
      path.join(root, "themes", "coffee.yml"),
      "base: coffee\nslots:\n  head: '<script>alert(1)</script>'\n  footer: '<img src=x onerror=alert(2)>'\n",
      "utf8",
    );

    const model = createModel((i) => ({
      name: `fn${i}`,
      desc: `safe text ${i}`,
      sig: `export function fn${i}(): void`,
      ex: `fn${i}()`,
      title: `Section ${i}`,
    }));

    const html = renderToHtml(model, { theme: "coffee", root });

    // The built-in's own palette is what rendered...
    expect(html).toContain(getTheme("coffee").light["--accent"] ?? "coffee-accent");
    // ...and none of the impostor's markup did.
    expect(html).not.toContain("<script>alert(1)</script>");
    expect(html).not.toContain("onerror=alert(2)");
  });
});
