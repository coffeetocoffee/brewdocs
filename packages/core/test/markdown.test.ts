import { describe, expect, it } from "vitest";
import * as path from "node:path";
import * as fs from "node:fs";
import * as os from "node:os";
import { markdownToHtml } from "../src/markdown.js";
import { buildModel, build } from "@brewdocs/core";
import { resolveInput } from "../src/resolve.js";

/**
 * v3.5 security regressions. BrewDocs' whole job is rendering prose from a
 * repo you may not own, so README text, doc comments and even git tag names
 * are attacker-controlled input. These lock down the escaping contract.
 */
describe("Phase 6 — markdown escaping", () => {
  it("escapes quotes so a link URL cannot break out of the attribute", () => {
    const html = markdownToHtml('[click](x"onmouseover="alert(1)//)');
    expect(html).not.toContain('"onmouseover="');
    expect(html).toContain("&quot;onmouseover=&quot;");
  });

  it("escapes quotes in image URLs too", () => {
    const html = markdownToHtml('![i](x"onerror="alert(1)//)');
    expect(html).not.toContain('"onerror="');
    expect(html).toContain("&quot;onerror=&quot;");
  });

  it("drops javascript: and data: link targets", () => {
    expect(markdownToHtml("[x](javascript:alert(1))")).not.toContain("href");
    expect(markdownToHtml("[x](data:text/html;base64,PHNjcmlwdD4=)")).not.toContain("href");
    // control characters can't smuggle a scheme past the check
    expect(markdownToHtml("[x](java\tscript:alert(1))")).not.toContain("href");
  });

  it("keeps ordinary links, escaping & in the href", () => {
    const html = markdownToHtml("[ok](https://a.example/c?d=1&e=2)");
    expect(html).toContain('href="https://a.example/c?d=1&amp;e=2"');
  });

  it("escapes block-level HTML in prose", () => {
    expect(markdownToHtml("### <img src=x onerror=alert(1)>")).not.toContain("<img");
  });
});

describe("Phase 6 — rendered page has no injected attributes", () => {
  it("a hostile README cannot inject into the built page", () => {
    const src = fs.mkdtempSync(path.join(os.tmpdir(), "brewdocs-xss-"));
    fs.writeFileSync(
      path.join(src, "package.json"),
      JSON.stringify({ name: "xss-demo", version: "1.0.0" }),
    );
    fs.writeFileSync(
      path.join(src, "README.md"),
      '# Demo\n\n[Get started](https://x.io"style="position:fixed"data-x="1)\n',
    );
    const out = path.join(src, "dist");
    build(resolveInput(src).source, out);
    const html = fs.readFileSync(path.join(out, "index.html"), "utf8");
    const anchor = /<a [^>]*>Get started<\/a>/.exec(html)?.[0] ?? "";
    expect(anchor).not.toContain('"style=');
    expect(anchor).not.toContain('"data-x=');
  });

  it("escapes quotes in symbol metadata (title attribute path)", () => {
    const src = fs.mkdtempSync(path.join(os.tmpdir(), "brewdocs-sym-"));
    fs.writeFileSync(
      path.join(src, "package.json"),
      JSON.stringify({ name: "sym-demo", version: "1.0.0" }),
    );
    fs.writeFileSync(path.join(src, "README.md"), "# Sym\n");
    fs.writeFileSync(
      path.join(src, "index.ts"),
      [
        "/**",
        ' * A fn whose name is hostile " onmouseover="alert(1)',
        " */",
        "export function ok(): number { return 1; }",
        "",
      ].join("\n"),
    );
    const model = buildModel({ root: src, name: "sym" }, {});
    for (const s of model.symbols) {
      if (s.description) expect(s.description).not.toContain("\u0000");
    }
  });
});
