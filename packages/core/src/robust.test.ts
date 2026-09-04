import { describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { buildModel } from "./build.js";
import { buildGallery, type GalleryEntry } from "./gallery.js";
import { renderToHtml } from "./render.js";
import type { RenderModel } from "./types.js";

function tmpPkg(files: Record<string, string>): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "brewdocs-robust-"));
  for (const [name, content] of Object.entries(files)) {
    const full = path.join(dir, name);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content, "utf8");
  }
  return dir;
}

describe("Phase 6 — robustness", () => {
  it("handles a package with no README (no crash, empty sections)", () => {
    const dir = tmpPkg({
      "package.json": JSON.stringify({ name: "bare", version: "1.0.0" }),
      "index.ts": "export const x = 1;",
    });
    const model = buildModel({ root: dir });
    expect(model.title).toBe("bare");
    expect(model.sections).toEqual([]);
    expect(Array.isArray(model.symbols)).toBe(true);
  });

  it("handles a package with no entry and no exports", () => {
    const dir = tmpPkg({
      "package.json": JSON.stringify({ name: "empty", version: "0.0.1" }),
    });
    const model = buildModel({ root: dir });
    expect(model.symbols).toEqual([]);
  });

  it("handles a malformed package.json gracefully", () => {
    const dir = tmpPkg({
      "package.json": "{ this is : not valid json",
      "README.md": "# Hi\n\nSome text.",
    });
    const model = buildModel({ root: dir });
    expect(model.sections.length).toBeGreaterThan(0);
    expect(model.pkg).toBeUndefined();
  });

  it("renders a friendly empty state when there is nothing to show", () => {
    const model: RenderModel = {
      title: "ghost",
      description: undefined,
      frontmatter: {},
      sections: [],
      metadata: {},
      symbols: [],
    };
    const html = renderToHtml(model);
    expect(html).toContain("Nothing brewed yet");
  });
});

describe("Phase 6 — gallery", () => {
  it("builds one page per entry plus a gallery index", () => {
    const a = tmpPkg({
      "package.json": JSON.stringify({ name: "alpha", version: "1.0.0" }),
      "README.md": "# Alpha\n\nFirst.",
    });
    const b = tmpPkg({
      "package.json": JSON.stringify({ name: "beta", version: "2.0.0" }),
      "README.md": "# Beta\n\nSecond.",
    });
    const out = fs.mkdtempSync(path.join(os.tmpdir(), "brewdocs-gallery-"));
    const entries: GalleryEntry[] = [
      { name: "alpha", root: a },
      { name: "beta", root: b },
    ];
    const idx = buildGallery(entries, out);
    expect(fs.existsSync(idx)).toBe(true);
    expect(fs.existsSync(path.join(out, "alpha", "index.html"))).toBe(true);
    expect(fs.existsSync(path.join(out, "beta", "index.html"))).toBe(true);
    const gallery = fs.readFileSync(idx, "utf8");
    expect(gallery).toContain("BrewDocs Gallery");
    expect(gallery).toContain("alpha");
    expect(gallery).toContain("beta");
  });
});
