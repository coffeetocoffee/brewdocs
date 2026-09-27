import { describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { build, emitDeployArtifacts, type RenderModel } from "@brewdocs/core";

const model: RenderModel = {
  title: "cool <lib>",
  frontmatter: {},
  sections: [],
  metadata: {},
  symbols: [],
};

describe("deploy artifacts", () => {
  it("writes 404.html, _headers and _redirects with safe content", () => {
    const out = fs.mkdtempSync(path.join(os.tmpdir(), "brewdocs-dep-"));
    const written = emitDeployArtifacts(out, model, {
      "old.html": "index.html",
      "blog/post.html": "https://example.com/post",
    });

    expect(written.map((f) => path.basename(f)).sort()).toEqual([
      "404.html",
      "_headers",
      "_redirects",
    ]);

    const notFound = fs.readFileSync(path.join(out, "404.html"), "utf8");
    expect(notFound).toContain("404");
    // Title is escaped, never injected as raw markup.
    expect(notFound).toContain("cool &lt;lib&gt;");
    expect(notFound).not.toContain("<lib>");

    const redirects = fs.readFileSync(path.join(out, "_redirects"), "utf8");
    expect(redirects).toContain("/old.html  /index.html  301");
    expect(redirects).toContain("/blog/post.html  https://example.com/post  301");

    expect(fs.readFileSync(path.join(out, "_headers"), "utf8")).toContain("nosniff");
  });

  it("omits _redirects when nothing is moved", () => {
    const out = fs.mkdtempSync(path.join(os.tmpdir(), "brewdocs-dep-"));
    emitDeployArtifacts(out, model, undefined);
    expect(fs.existsSync(path.join(out, "404.html"))).toBe(true);
    expect(fs.existsSync(path.join(out, "_redirects"))).toBe(false);
  });

  it("a real build emits the deploy files", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "brewdocs-dep-src-"));
    fs.writeFileSync(path.join(root, "index.ts"), "export const x = 1;\n");
    fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ name: "da", main: "index.ts" }));
    fs.writeFileSync(path.join(root, "brewdocs.yml"), "redirects:\n  old.html: index.html\n");

    const out = path.join(root, "site");
    build({ root, name: "da" }, out);

    expect(fs.existsSync(path.join(out, "404.html"))).toBe(true);
    expect(fs.existsSync(path.join(out, "_headers"))).toBe(true);
    expect(fs.readFileSync(path.join(out, "_redirects"), "utf8")).toContain("/old.html");
  });
});
