import { describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { buildMarkdown, renderToMarkdown } from "./markdown-export.js";
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
});
