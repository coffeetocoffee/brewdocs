import { describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  buildMarkdown,
  buildMarkdownMulti,
  renderToMarkdown,
  renderToMarkdownMulti,
} from "./markdown-export.js";
import { buildModel } from "./build.js";

const EXAMPLES = path.resolve(__dirname, "../../../examples");
const libRoot = path.join(EXAMPLES, "lib");

function tmp(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "brewdocs-md-"));
}

describe("Direction C-free — Markdown/MDX export", () => {
  it("renders the DocModel to Markdown with package + API reference", () => {
    const model = buildModel({ root: libRoot, name: "lib" });
    const md = renderToMarkdown(model);
    expect(md).toContain("# lib");
    expect(md).toContain("## API Reference");
    expect(md).toContain("_(");
    expect(md).toContain("**Parameters**");
    expect(md).toContain("**Returns**");
    expect(md).toContain("```ts");
  });

  it("emits a YAML frontmatter block for mdx", () => {
    const model = buildModel({ root: libRoot, name: "lib" });
    const md = renderToMarkdown(model, { format: "mdx" });
    expect(md.startsWith("---\n")).toBe(true);
    expect(md).toContain("title:");
  });

  it("embeds the raw README verbatim for fidelity", async () => {
    const out = tmp();
    const file = await buildMarkdown({ root: libRoot, name: "lib" }, out, { format: "md" });
    const md = fs.readFileSync(file, "utf8");
    // examples/lib/README.md body text should survive into the Markdown output.
    expect(md).toContain("A small library used to exercise");
  });

  it("buildMarkdown writes docs.md (and docs.mdx) to disk", async () => {
    const out = tmp();
    const md = await buildMarkdown({ root: libRoot, name: "lib" }, out, { format: "md" });
    expect(md.endsWith("docs.md")).toBe(true);
    expect(fs.existsSync(md)).toBe(true);
    const mdx = await buildMarkdown({ root: libRoot, name: "lib" }, out, { format: "mdx" });
    expect(fs.existsSync(mdx)).toBe(true);
    const text = fs.readFileSync(md, "utf8");
    expect(text).toContain("# lib");
  });

  it("stamps freshness (version + rev + date) into the footer", () => {
    const model = buildModel({ root: libRoot, name: "lib" });
    const md = renderToMarkdown(model, {
      freshness: { version: "1.2.0", gitSha: "abcdef1234567890", generatedAt: "2026-09-05T00:00:00.000Z" },
    });
    expect(md).toContain("v1.2.0");
    expect(md).toContain("rev abcdef1");
    expect(md).toContain("2026-09-05");
  });

  it("emits one portable page per symbol (same shape as --multi HTML)", () => {
    const model = buildModel({ root: libRoot, name: "lib" });
    const pages = renderToMarkdownMulti(model);
    expect(pages[0].path).toBe("index.md");
    expect(pages.length).toBe(1 + model.symbols.length);
    for (const sym of model.symbols) {
      const page = pages.find((p) => p.path === `symbols/${sym.name.toLowerCase()}.md`);
      expect(page).toBeTruthy();
      // H1 names the symbol (self-link excluded, like --multi HTML).
      expect(page!.body).toContain(`# \`${sym.name}\` _(`);
    }
    // index links point at the per-symbol files
    expect(pages[0].body).toContain("(./symbols/");
    // version-aware index
    expect(pages[0].body).toContain("**Version:** 1.2.0");
  });

  it("buildMarkdownMulti writes index.md + symbols/ to disk", () => {
    const out = tmp();
    const files = buildMarkdownMulti({ root: libRoot, name: "lib" }, out);
    expect(files.length).toBeGreaterThan(1);
    expect(fs.existsSync(path.join(out, "index.md"))).toBe(true);
    expect(fs.existsSync(path.join(out, "symbols"))).toBe(true);
    for (const f of files) expect(fs.existsSync(f)).toBe(true);
    const index = fs.readFileSync(path.join(out, "index.md"), "utf8");
    expect(index).toContain("# lib");
    expect(index).toContain("(./symbols/");
  });
});
