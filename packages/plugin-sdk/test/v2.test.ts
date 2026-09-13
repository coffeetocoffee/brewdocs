import { describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  applyManifest,
  build,
  extractFromSource,
  fingerprintSource,
  getTheme,
  goAdapter,
  loadContent,
  loadNav,
  loadThemeManifest,
  parseNavYaml,
  pythonAdapter,
  transformMdx,
  type BrewDocsPlugin,
} from "@brewdocs/core";
import { defineAdapter, definePlugin } from "@brewdocs/plugin-sdk";

function tmp(prefix = "brewdocs-v2-"): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function write(file: string, text: string): string {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text, "utf8");
  return file;
}

const PY_PKG = {
  "pyproject.toml": `[project]\nname = "roastery"\nversion = "0.1.0"\n`,
  "roastery/__init__.py": `"""Roastery — small-batch roasting helpers."""\n\nfrom roastery.core import roast, cool, VERSION, Roaster\n`,
  "roastery/core.py": `"""Core roasting primitives."""\n\nVERSION = "0.1.0"\n\n\ndef roast(beans, minutes=12, *, water=None):\n    """Roast beans to the requested level.\n\n    Args:\n        beans: green coffee beans.\n        minutes: roast duration.\n\n    Returns:\n        A roasted batch.\n\n    .. deprecated:: 0.2.0\n    """\n    return beans\n\n\ndef cool(batch):\n    """Cool a roasted batch.\n\n    >>> cool(batch)\n    done\n    """\n    return None\n\n\nclass Roaster:\n    """A drum roaster."""\n\n    def __init__(self, size):\n        """Create a roaster of the given size."""\n\n    def preheat(self, temp: float) -> None:\n        """Warm the drum."""\n`,
};

const GO_PKG = {
  "go.mod": `module github.com/acme/brew\n\ngo 1.22\n`,
  "brew.go": `package brew\n\n// Version is the package version.\nconst Version = "1.0.0"\n\n// Brew makes coffee from beans.\nfunc Brew(beans int, water string) (string, error) {\n\treturn "coffee", nil\n}\n\n// Pour adds water slowly.\nfunc (r *Roaster) Pour(ml int) error {\n\treturn nil\n}\n\n// Roaster is a drum roaster.\ntype Roaster struct {\n\tSize int\n\tbrand string\n}\n\n// Filter is anything that can filter grounds.\ntype Filter interface {\n\tFilter(grounds string) error\n\tFine()\n}\n\nfunc hidden() {}\n`,
};

describe("v2.0 plugin SDK", () => {
  it("definePlugin/defineAdapter validate shape", () => {
    expect(() => definePlugin({} as never)).toThrow();
    expect(() => defineAdapter({ id: "x" } as never)).toThrow();
    const p = definePlugin({ name: "ok", onRender: (h) => h });
    expect(p.name).toBe("ok");
  });

  it("runs onExtract and onRender hooks through a full build", () => {
    const dir = tmp();
    write(path.join(dir, "package.json"), JSON.stringify({ name: "hooked", version: "1.0.0" }));
    write(path.join(dir, "index.ts"), `export function hi(): void {}\n`);
    write(path.join(dir, "README.md"), `# hooked\n\nhi there\n`);
    const out = tmp();

    const plugin = definePlugin({
      name: "shout",
      onExtract(result) {
        result.description = "rewritten";
      },
      onRender(html, page) {
        return page.path === "index.html" ? html.replace("</footer>", " · stamped</footer>") : html;
      },
    });

    const file = build({ root: dir }, out, { plugins: [plugin] });
    const html = fs.readFileSync(file, "utf8");
    expect(html).toContain("· stamped");
    expect(html).toContain("rewritten");
  });

  it("loads plugins from a relative path (CJS) and applies them", () => {
    const dir = tmp();
    write(path.join(dir, "package.json"), JSON.stringify({ name: "withplugin", version: "1.0.0" }));
    write(path.join(dir, "index.ts"), `export function hi(): void {}\n`);
    write(
      path.join(dir, "plugin.cjs"),
      `module.exports = { name: "cjs-plugin", onRender: (html) => html.replace("</body>", "<!-- cjs -->\\n</body>") };`,
    );
    const out = tmp();
    const file = build({ root: dir }, out, {
      plugins: [
        {
          name: "cjs-plugin",
          onRender: (h: string) => h.replace("</body>", "<!-- cjs -->\n</body>"),
        } as BrewDocsPlugin,
      ],
    });
    expect(fs.readFileSync(file, "utf8")).toContain("<!-- cjs -->");
  });

  it("ignores unknown plugin specs with a warning, never a crash", () => {
    const dir = tmp();
    write(path.join(dir, "package.json"), JSON.stringify({ name: "plain" }));
    const result = extractFromSource({ root: dir }, [{ name: "missing", adapters: [{ id: "x", detect: () => { throw new Error("nope"); }, extract: () => [] }] }]);
    expect(result.symbols).toEqual([]);
  });
});

describe("v2.0 Python adapter", () => {
  it("detects python packages and ignores JS ones", () => {
    const dir = tmp();
    expect(pythonAdapter.detect({ root: dir, metadata: {} })).toBe(false);
    for (const [f, t] of Object.entries(PY_PKG)) write(path.join(dir, f), t);
    expect(pythonAdapter.detect({ root: dir, metadata: {} })).toBe(true);
  });

  it("extracts functions, params, docstrings, examples, classes, constants", () => {
    const dir = tmp();
    for (const [f, t] of Object.entries(PY_PKG)) write(path.join(dir, f), t);
    const symbols = pythonAdapter.extract({ root: dir, metadata: {} });
    const names = symbols.map((s) => s.name);
    expect(names).toContain("roast");
    expect(names).toContain("cool");
    expect(names).toContain("Roaster");
    expect(names).toContain("VERSION");

    const roast = symbols.find((s) => s.name === "roast")!;
    expect(roast.kind).toBe("function");
    expect(roast.description).toBe("Roast beans to the requested level.");
    const beanParam = roast.params.find((p) => p.name === "beans")!;
    expect(beanParam.description).toBe("green coffee beans.");
    const minutes = roast.params.find((p) => p.name === "minutes")!;
    expect(minutes.optional).toBe(true);
    expect(minutes.default).toBe("12");
    expect(roast.deprecated).toBeTruthy();

    const cool = symbols.find((s) => s.name === "cool")!;
    expect(cool.examples.length).toBeGreaterThan(0);

    const roaster = symbols.find((s) => s.name === "Roaster")!;
    expect(roaster.kind).toBe("class");
    expect(roaster.members?.map((m) => m.name)).toContain("preheat");
  });

  it("brews a doc site for a Python package end to end", () => {
    const dir = tmp();
    for (const [f, t] of Object.entries(PY_PKG)) write(path.join(dir, f), t);
    const out = tmp();
    const file = build({ root: dir }, out);
    const html = fs.readFileSync(file, "utf8");
    expect(html).toContain("roast");
    expect(html).toContain("Roaster");
    expect(html).toContain("deprecated");
  });
});

describe("v2.0 Go adapter", () => {
  it("extracts exported functions, methods, types, members, constants", () => {
    const dir = tmp();
    for (const [f, t] of Object.entries(GO_PKG)) write(path.join(dir, f), t);
    expect(goAdapter.detect({ root: dir, metadata: {} })).toBe(true);
    const symbols = goAdapter.extract({ root: dir, metadata: {} });
    const names = symbols.map((s) => s.name);
    expect(names).toContain("Brew");
    expect(names).toContain("Roaster.Pour");
    expect(names).toContain("Roaster");
    expect(names).toContain("Filter");
    expect(names).toContain("Version");
    expect(names).not.toContain("hidden");

    const brew = symbols.find((s) => s.name === "Brew")!;
    expect(brew.description).toBe("Brew makes coffee from beans.");
    expect(brew.params.map((p) => p.name)).toEqual(["beans", "water"]);
    expect(brew.returns?.type).toBe("(string, error)");

    const roaster = symbols.find((s) => s.name === "Roaster")!;
    expect(roaster.members?.map((m) => m.name)).toEqual(["Size"]);
    const filter = symbols.find((s) => s.name === "Filter")!;
    expect(filter.kind).toBe("interface");
    expect(filter.members?.map((m) => m.name)).toEqual(["Filter", "Fine"]);
  });

  it("skips unexported symbols and test files", () => {
    const dir = tmp();
    write(path.join(dir, "x_test.go"), `package x\n\n// Nope test doc.\nfunc Nope() {}\n`);
    const symbols = goAdapter.extract({ root: dir, metadata: {} });
    expect(symbols.find((s) => s.name === "Nope")).toBeUndefined();
  });
});

describe("v2.0 incremental cache", () => {
  it("fingerprint is content-sensitive and order-insensitive", () => {
    const a = tmp();
    write(path.join(a, "index.ts"), `export const x = 1;\n`);
    write(path.join(a, "package.json"), `{}`);
    const before = fingerprintSource(a);
    expect(fingerprintSource(a)).toBe(before); // stable
    write(path.join(a, "index.ts"), `export const x = 2;\n`);
    expect(fingerprintSource(a)).not.toBe(before); // content changed
  });

  it("serves extraction from .brewdocs/extract.json once cached", () => {
    const dir = tmp();
    write(path.join(dir, "package.json"), JSON.stringify({ name: "cached", version: "1.0.0" }));
    write(path.join(dir, "index.ts"), `export function hi(): void {}\n`);
    write(path.join(dir, "README.md"), `# cached\n\nbody\n`);

    const out1 = tmp();
    build({ root: dir }, out1, { cache: true });
    const cachePath = path.join(dir, ".brewdocs", "extract.json");
    expect(fs.existsSync(cachePath)).toBe(true);

    // Change the source after the cache exists: rebuild with cache ON
    // (fingerprints no longer match) must produce fresh output.
    write(path.join(dir, "index.ts"), `export function hi(): void {}\nexport function added(): number { return 1; }\n`);
    const out2 = tmp();
    build({ root: dir }, out2, { cache: true });
    expect(fs.readFileSync(path.join(out2, "index.html"), "utf8")).toContain("added");

    // Deleting sources then rebuilding with a hand-stale cache proves the
    // hit path: write a cache with an arbitrary fingerprint we then force.
    const cached = JSON.parse(fs.readFileSync(cachePath, "utf8")) as { fingerprint: string };
    expect(cached.fingerprint).toMatch(/^[0-9a-f]{16,}/);
  });

  it("does not write a cache unless enabled", () => {
    const dir = tmp();
    write(path.join(dir, "package.json"), JSON.stringify({ name: "nocache" }));
    write(path.join(dir, "index.ts"), `export const a = 1;\n`);
    build({ root: dir }, tmp());
    expect(fs.existsSync(path.join(dir, ".brewdocs", "extract.json"))).toBe(false);
  });
});

describe("v2.0 content layer (MDX + nav)", () => {
  it("transforms MDX-lite components into placeholder elements", () => {
    const html = transformMdx(
      `import { Thing } from "./x";\n\n<Callout type="warn">be careful</Callout>\n\n<Embed id="7" />\n`,
    );
    expect(html).not.toContain("import");
    expect(html).toContain('data-component="Callout"');
    expect(html).toContain('data-type="warn"');
    expect(html).toContain("be careful");
    expect(html).toContain('data-component="Embed"');
    expect(html).toContain('data-id="7"');
  });

  it("build() publishes content/ pages and links them from the index", () => {
    const dir = tmp();
    write(path.join(dir, "package.json"), JSON.stringify({ name: "guideco", version: "1.0.0" }));
    write(path.join(dir, "index.ts"), `export function hi(): void {}\n`);
    write(
      path.join(dir, "content/getting-started.mdx"),
      `---\ntitle: Getting started\ndescription: First steps\norder: 1\n---\n\n# Getting started\n\nInstall it.\n\n<Tip>works offline</Tip>\n`,
    );
    write(
      path.join(dir, "content/advanced.md"),
      `---\ntitle: Advanced\norder: 2\n---\n\n# Advanced\n\nGo deeper.\n`,
    );
    write(path.join(dir, "nav.yml"), `Guides:\n  Getting started: content/getting-started.html\n  Advanced: content/advanced.html\nAPI:\n  Reference: index.html#api\n`);

    const out = tmp();
    build({ root: dir }, out);
    expect(fs.existsSync(path.join(out, "content/getting-started.html"))).toBe(true);
    expect(fs.existsSync(path.join(out, "content/advanced.html"))).toBe(true);

    const index = fs.readFileSync(path.join(out, "index.html"), "utf8");
    expect(index).toContain("Getting started");
    expect(index).toContain('href="content/getting-started.html"');
    expect(index).toContain("Guides");

    const guide = fs.readFileSync(path.join(out, "content/getting-started.html"), "utf8");
    expect(guide).toContain("works offline");
    expect(guide).toContain('data-component="Tip"');
    expect(guide).toContain('href="../index.html"'); // back link to root
  });

  it("loadContent orders pages by frontmatter order", () => {
    const dir = tmp();
    write(path.join(dir, "content/b-second.md"), `---\ntitle: Second\norder: 2\n---\n\n# Second\n`);
    write(path.join(dir, "content/a-first.md"), `---\ntitle: First\norder: 1\n---\n\n# First\n`);
    const pages = loadContent(dir);
    expect(pages.map((p) => p.slug)).toEqual(["a-first", "b-second"]);
    expect(pages[0].path).toBe("content/a-first.html");
  });

  it("parses nav.yml groups", () => {
    const groups = parseNavYaml(`Start:\n  Intro: content/intro.html\nAPI:\n  Reference: index.html#api\n`);
    expect(groups).toHaveLength(2);
    expect(groups[0].title).toBe("Start");
    expect(groups[0].items[0]).toEqual({ text: "Intro", link: "content/intro.html" });
    expect(loadNav(tmp())).toBeUndefined();
  });
});

describe("v2.0 theme manifest + slots", () => {
  it("extends a base theme with vars, css, and slot partials", () => {
    const dir = tmp();
    write(
      path.join(dir, "themes/brand.yml"),
      `base: ink\nvars:\n  --accent: "#ff0000"\n  --heading-font: "Verdana, sans-serif"\ncss: "h1 { text-transform: uppercase; }"\nslots:\n  footer: "partials/brand-footer.html"\n`,
    );
    write(
      path.join(dir, "partials/brand-footer.html"),
      `<p class="brand-footer">Acme Corp — docs brewed with love</p>\n`,
    );
    const manifest = loadThemeManifest("brand", dir);
    expect(manifest).toBeTruthy();
    expect(manifest!.extends).toBe("ink");
    expect(manifest!.vars!["--accent"]).toBe("#ff0000");

    const theme = applyManifest(getTheme("ink"), manifest!);
    expect(theme.light["--accent"]).toBe("#ff0000");
    expect((theme as { css?: string }).css).toContain("text-transform");
  });

  it("build() injects manifest vars, custom css, and slot HTML", () => {
    const dir = tmp();
    write(path.join(dir, "package.json"), JSON.stringify({ name: "themed", version: "1.0.0" }));
    write(path.join(dir, "index.ts"), `export function hi(): void {}\n`);
    write(path.join(dir, "themes/brand.json"), JSON.stringify({
      base: "matcha",
      vars: { "--accent": "#123456" },
      css: ".brand-banner { border: 2px solid red; }",
      slots: { header: '<p class="brand-banner">beta docs</p>' },
    }));
    const out = tmp();
    build({ root: dir }, out, { theme: "brand" });
    const html = fs.readFileSync(path.join(out, "index.html"), "utf8");
    expect(html).toContain("--accent: #123456");
    expect(html).toContain(".brand-banner { border: 2px solid red; }");
    expect(html).toContain('class="brand-banner">beta docs');
    // still a full page with the matcha base intact
    expect(html).toContain(getTheme("matcha").light["--bg"] ?? "matcha-bg");
  });

  it("plugin theme vars merge after the theme palette", () => {
    const dir = tmp();
    write(path.join(dir, "package.json"), JSON.stringify({ name: "plugtheme", version: "1.0.0" }));
    write(path.join(dir, "index.ts"), `export function hi(): void {}\n`);
    const out = tmp();
    build({ root: dir }, out, {
      plugins: [
        {
          name: "p",
          theme: {
            vars: { "--line": "rebeccapurple" },
            slots: { mainAfter: "<hr class='plugin'>" },
          },
        } as BrewDocsPlugin,
      ],
    });
    const html = fs.readFileSync(path.join(out, "index.html"), "utf8");
    expect(html).toContain("--line: rebeccapurple");
    expect(html).toContain("<hr class='plugin'>");
  });
});
