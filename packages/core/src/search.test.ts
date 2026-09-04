import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { buildSearchIndex } from "./search.js";
import { discoverVersions } from "./versions.js";
import { renderToHtml } from "./render.js";
import type { RenderModel } from "./types.js";

const EXAMPLES = path.resolve(__dirname, "../../../examples");

const model: RenderModel = {
  title: "demo",
  description: "A demo",
  frontmatter: {},
  sections: [
    { id: "intro", title: "Intro", level: 2, html: "<p>Welcome to the intro section.</p>" },
    { id: "api", title: "API", level: 2, html: "<p>The api reference.</p>" },
  ],
  metadata: {},
  symbols: [
    {
      name: "brew",
      kind: "function",
      signature: "export function brew(): void",
      description: "Brew a fresh cup of docs.",
      params: [{ name: "x", type: "string", description: "the source", optional: false }],
      returns: { type: "string", description: "output" },
      examples: [],
    },
  ],
};

describe("Phase 3 — search index", () => {
  it("indexes sections and symbols with urls", () => {
    const idx = buildSearchIndex(model);
    expect(idx.map((d) => d.id)).toEqual(["intro", "api", "symbol-brew"]);
    const sym = idx.find((d) => d.id === "symbol-brew")!;
    expect(sym.url).toBe("#symbol-brew");
    expect(sym.body).toContain("Brew a fresh cup");
    expect(sym.body).toContain("the source");
  });
});

describe("Phase 3 — version discovery", () => {
  it("returns the package version for a directory outside any git repo", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "brewdocs-nogit-"));
    try {
      fs.writeFileSync(
        path.join(tmp, "package.json"),
        JSON.stringify({ name: "x", version: "3.1.4" }),
      );
      const versions = await discoverVersions(tmp);
      expect(versions).toEqual(["3.1.4"]);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("discovers git tags for a monorepo subdirectory", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "brewdocs-git-"));
    try {
      fs.writeFileSync(
        path.join(tmp, "package.json"),
        JSON.stringify({ name: "x", version: "1.0.0" }),
      );
      fs.mkdirSync(path.join(tmp, "packages", "pkg"), { recursive: true });
      fs.writeFileSync(
        path.join(tmp, "packages", "pkg", "package.json"),
        JSON.stringify({ name: "pkg", version: "2.0.0" }),
      );
      const run = (args: string[]) =>
        execFileSync("git", args, { cwd: tmp, stdio: "ignore" });
      run(["init"]);
      run(["config", "user.email", "test@example.com"]);
      run(["config", "user.name", "test"]);
      run(["add", "."]);
      run(["commit", "-m", "init"]);
      run(["tag", "v9.9.9"]);
      // Subdirectory of the repo: git root discovery must walk up.
      const versions = await discoverVersions(path.join(tmp, "packages", "pkg"));
      expect(versions).toContain("v9.9.9");
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});

describe("Phase 3 — render with search + versions", () => {
  it("embeds the search index and a command-palette trigger", () => {
    const html = renderToHtml(model);
    expect(html).toContain('id="search-index"');
    expect(html).toContain('id="search-toggle"');
    expect(html).toContain("search-overlay");
    expect(html).toContain("⌘K");
  });

  it("wires up the keyboard shortcut and renders results client-side", () => {
    const html = renderToHtml(model);
    expect(html).toContain('e.key.toLowerCase() === "k"');
    expect(html).toContain("search-index");
  });

  it("renders a version switcher when multiple versions are supplied", () => {
    const html = renderToHtml(model, {
      versions: [
        { version: "1.0.0", path: "./1.0.0/index.html" },
        { version: "1.2.0", path: "./1.2.0/index.html" },
      ],
      currentVersion: "1.2.0",
    });
    expect(html).toContain("<option");
    expect(html).toContain("1.2.0");
    expect(html).toContain("./1.0.0/index.html");
  });

  it("shows a plain version label with a single version", () => {
    const html = renderToHtml(model, {
      versions: [{ version: "1.2.0", path: "./index.html" }],
      currentVersion: "1.2.0",
    });
    expect(html).toContain("v1.2.0");
    expect(html).not.toContain("<option");
  });
});
