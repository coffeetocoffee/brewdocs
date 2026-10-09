import { beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  build,
  isBuiltinTheme,
  loadThemeManifest,
  renderToHtml,
  resolveThemeRef,
  themeFromRef,
  __resetThemeWarnings,
  type RenderModel,
} from "@brewdocs/core";

/**
 * Finding #32: a theme manifest is the same trust position as a plugin — it
 * carries raw slot HTML (`slots.head`, `slots.footer`) and a css blob, both of
 * which the renderer interpolates verbatim. D-9 already states the rule ("a
 * plugin is arbitrary code, so only the operator may choose them", INV-20);
 * the theme channel was not cut the same way, and it had a wider door because
 * `--theme ink` is the documented invocation.
 *
 * Two vectors are covered here, both reproduced by execution before the fix:
 *   A. a repo shipping `themes/ink.yml` hijacked the *built-in* `ink`, so even
 *      the README quick-start (`build <repo> --theme ink`) emitted attacker
 *      script;
 *   B. a fetched (npm/git) source named its own theme in brewdocs.yml and got
 *      it loaded, bypassing the plugin guard that already refuses exactly that
 *      (finding #19) — the theme half of the same threat model.
 *
 * The fix is provenance, not escaping: raw slot HTML is the feature, so the
 * question is who is allowed to choose the manifest. A locally chosen repo may
 * still ship one (that is the feature); the operator's explicit path always
 * wins, on a fetched source or not.
 */

const outDir = (): string => fs.mkdtempSync(path.join(os.tmpdir(), "brewdocs-theme-out-"));

/** A repo whose own theme manifest carries a script in a raw slot. */
function repoWithTheme(opts: {
  name: string;
  theme: string;
  marker: string;
  config?: string;
}): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "brewdocs-theme-"));
  fs.mkdirSync(path.join(root, "themes"), { recursive: true });
  fs.writeFileSync(path.join(root, "README.md"), "# themed\n", "utf8");
  fs.writeFileSync(
    path.join(root, "package.json"),
    JSON.stringify({ name: "themed", version: "1.0.0" }),
    "utf8",
  );
  fs.writeFileSync(
    path.join(root, "index.ts"),
    "/** A library. */\nexport function hi(): void {}\n",
    "utf8",
  );
  fs.writeFileSync(
    path.join(root, "themes", `${opts.name}.yml`),
    [
      `base: ${opts.theme}`,
      "slots:",
      `  head: '<script>${opts.marker}</script>'`,
      "  footer: '<img src=x onerror=\"${opts.marker}\">'",
    ].join("\n"),
    "utf8",
  );
  if (opts.config) fs.writeFileSync(path.join(root, "brewdocs.yml"), opts.config, "utf8");
  return root;
}

function model(): RenderModel {
  return {
    title: "themed",
    description: "",
    frontmatter: {},
    metadata: {},
    sections: [],
    symbols: [],
  };
}

/** Script/handler injected through a raw slot, not through the style channel. */
function injectedSlot(html: string, marker: string): boolean {
  return html.includes(`<script>${marker}</script>`) || html.includes(`onerror="${marker}"`);
}

beforeEach(() => {
  __resetThemeWarnings();
});

describe("v4.8 a repo manifest cannot shadow a built-in theme (finding #32)", () => {
  it("does not resolve themes/<builtin>.yml for a bare built-in name", () => {
    const root = repoWithTheme({ name: "ink", theme: "ink", marker: "alert(1)" });

    // The name is the built-in's; the file must not be found.
    expect(loadThemeManifest("ink", root)).toBeNull();
    // ...and the built-in itself still resolves.
    expect(isBuiltinTheme("ink")).toBe(true);
  });

  it("renders the built-in, not the repo's impostor, for --theme ink", () => {
    const root = repoWithTheme({ name: "ink", theme: "ink", marker: "alert(1)" });
    const out = outDir();

    build({ root, name: "themed" }, out, { theme: "ink" });

    const html = fs.readFileSync(path.join(out, "index.html"), "utf8");
    expect(injectedSlot(html, "alert(1)")).toBe(false);
  });

  it("is not hijacked by a repo's own brewdocs.yml either (no CLI flag at all)", () => {
    // The README quick-start shape: build <repo>, nothing else. The repo names
    // the theme in its own config and ships the manifest for it.
    const root = repoWithTheme({
      name: "ink",
      theme: "ink",
      marker: "alert(7)",
      config: "theme: ink\n",
    });
    const out = outDir();

    build({ root, name: "themed" }, out, {});

    const html = fs.readFileSync(path.join(out, "index.html"), "utf8");
    expect(injectedSlot(html, "alert(7)")).toBe(false);
  });

  it("still lets a non-builtin name resolve to a repo manifest (the feature)", () => {
    const root = repoWithTheme({ name: "brand", theme: "ink", marker: "alert(2)" });

    const manifest = loadThemeManifest("brand", root);
    expect(manifest).toBeTruthy();
    expect(manifest!.extends).toBe("ink");
  });

  it("still applies a locally chosen custom theme's vars and slots", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "brewdocs-theme-local-"));
    fs.mkdirSync(path.join(root, "themes"), { recursive: true });
    fs.writeFileSync(path.join(root, "README.md"), "# local\n", "utf8");
    fs.writeFileSync(
      path.join(root, "package.json"),
      JSON.stringify({ name: "local", version: "1.0.0" }),
      "utf8",
    );
    fs.writeFileSync(
      path.join(root, "themes", "brand.yml"),
      "base: ink\nvars:\n  --accent: '#ff0000'\nslots:\n  footer: '<p>legit footer</p>'\n",
      "utf8",
    );
    const out = outDir();

    build({ root, name: "local" }, out, { theme: "brand" });

    const html = fs.readFileSync(path.join(out, "index.html"), "utf8");
    expect(html).toContain("--accent: #ff0000");
    expect(html).toContain("legit footer");
  });

  it("lets the operator select a manifest by explicit path, built-in name or not", () => {
    const root = repoWithTheme({ name: "ink", theme: "ink", marker: "alert(9)" });

    // An explicit path is the operator's decision, so the file IS read.
    const manifest = loadThemeManifest("./themes/ink.yml", root);
    expect(manifest).toBeTruthy();
  });
});

describe("v4.8 a fetched source cannot choose its own theme (finding #32)", () => {
  it("drops the repo's theme and warns, naming the escape hatch", () => {
    const root = repoWithTheme({
      name: "brand",
      theme: "ink",
      marker: "alert(3)",
      config: "theme: brand\n",
    });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    try {
      build({ root, name: "themed", fetched: true }, outDir());

      const themeWarnings = warn.mock.calls
        .map((c) => String(c[0]))
        .filter((m) => m.includes("theme"));
      expect(themeWarnings).toHaveLength(1);
      expect(themeWarnings[0]).toContain("fetched source");
      // The message must point at the supported escape hatch.
      expect(themeWarnings[0]).toContain("--theme");
    } finally {
      warn.mockRestore();
    }
  });

  it("produces no injected slot markup from the fetched repo's manifest", () => {
    const root = repoWithTheme({
      name: "brand",
      theme: "ink",
      marker: "alert(3)",
      config: "theme: brand\n",
    });
    const out = outDir();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    try {
      build({ root, name: "themed", fetched: true }, out, {});

      const html = fs.readFileSync(path.join(out, "index.html"), "utf8");
      expect(injectedSlot(html, "alert(3)")).toBe(false);
    } finally {
      warn.mockRestore();
    }
  });

  it("still builds the site — the theme is dropped, not the build", () => {
    const root = repoWithTheme({
      name: "brand",
      theme: "ink",
      marker: "alert(3)",
      config: "theme: brand\n",
    });
    const out = outDir();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    try {
      const file = build({ root, name: "themed", fetched: true }, out, {});
      expect(fs.existsSync(file)).toBe(true);
      expect(fs.readFileSync(file, "utf8")).toContain("<!doctype html>");
    } finally {
      warn.mockRestore();
    }
  });

  it("honours an explicit path the operator passed, even for a fetched source", () => {
    const root = repoWithTheme({ name: "brand", theme: "ink", marker: "alert(4)" });
    const out = outDir();

    // The operator naming the file is the caller's own decision (D-9).
    build({ root, name: "themed", fetched: true }, out, { theme: "./themes/brand.yml" });

    const html = fs.readFileSync(path.join(out, "index.html"), "utf8");
    expect(injectedSlot(html, "alert(4)")).toBe(true);
  });

  it("is not bypassed by a fetched repo writing an explicit path in its own config", () => {
    // The first version of this fix tested the *shape* of the reference, so a
    // repo whose brewdocs.yml said `theme: ./themes/evil.yml` supplied a
    // path-shaped string and got its manifest loaded anyway. Caught by
    // execution, not by reading. The rule must be about WHO supplied the
    // reference, not what it looks like.
    const root = repoWithTheme({
      name: "evil",
      theme: "ink",
      marker: "alert(11)",
      config: "theme: ./themes/evil.yml\n",
    });
    const out = outDir();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    try {
      build({ root, name: "themed", fetched: true }, out, {});

      const html = fs.readFileSync(path.join(out, "index.html"), "utf8");
      expect(injectedSlot(html, "alert(11)")).toBe(false);
      expect(warn.mock.calls.map((c) => String(c[0])).some((m) => m.includes("theme"))).toBe(true);
    } finally {
      warn.mockRestore();
    }
  });

  it("is not bypassed by a fetched repo's themeFile key naming an explicit path", () => {
    const root = repoWithTheme({
      name: "evil",
      theme: "ink",
      marker: "alert(12)",
      config: "themeFile: ./themes/evil.yml\n",
    });
    const out = outDir();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    try {
      build({ root, name: "themed", fetched: true }, out, {});

      const html = fs.readFileSync(path.join(out, "index.html"), "utf8");
      expect(injectedSlot(html, "alert(12)")).toBe(false);
    } finally {
      warn.mockRestore();
    }
  });

  it("loads a repo-named theme from a locally chosen source (the feature is preserved)", () => {
    const root = repoWithTheme({
      name: "brand",
      theme: "ink",
      marker: "alert(5)",
      config: "theme: brand\n",
    });
    const out = outDir();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    try {
      build({ root, name: "themed" }, out, {});

      const html = fs.readFileSync(path.join(out, "index.html"), "utf8");
      expect(injectedSlot(html, "alert(5)")).toBe(true);
      expect(warn.mock.calls.map((c) => String(c[0])).some((m) => m.includes("theme"))).toBe(false);
    } finally {
      warn.mockRestore();
    }
  });

  it("does not warn when a fetched source names no theme", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "brewdocs-theme-none-"));
    fs.writeFileSync(path.join(root, "index.ts"), "export function hi(): void {}\n", "utf8");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    try {
      build({ root, fetched: true }, outDir());
      expect(warn.mock.calls.map((c) => String(c[0])).some((m) => m.includes("theme"))).toBe(false);
    } finally {
      warn.mockRestore();
    }
  });
});

describe("v4.8 the theme guard survives every render path (finding #32)", () => {
  it("renderToHtml re-resolves the theme, so it needs the fetched flag too", () => {
    // Slots are materialized by resolveSetup (build.ts); the renderer resolves
    // vars/css itself, so that is the half this asserts.
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "brewdocs-theme-render-"));
    fs.mkdirSync(path.join(root, "themes"), { recursive: true });
    fs.writeFileSync(
      path.join(root, "themes", "brand.yml"),
      "base: ink\ncss: '.brand-marker { color: red; }'\n",
      "utf8",
    );

    // The renderer resolves the theme per page; without the flag on
    // RenderOptions the guard build.ts applied would be re-opened here.
    const guarded = renderToHtml(model(), { theme: "brand", root, fetched: true });
    expect(guarded).not.toContain(".brand-marker");

    // Same call, local source: the manifest is honoured.
    const local = renderToHtml(model(), { theme: "brand", root });
    expect(local).toContain(".brand-marker");
  });

  it("themeFromRef honours the fetched flag directly", () => {
    const root = repoWithTheme({ name: "brand", theme: "ink", marker: "alert(8)" });

    expect(themeFromRef("brand", root, true).css).toBeUndefined();
    const local = themeFromRef("brand", root, false);
    expect(local.name).toBe("brand");
  });

  it("resolveThemeRef ignores a fetched repo's themeFile config key", () => {
    const root = repoWithTheme({ name: "brand", theme: "ink", marker: "alert(8)" });
    fs.writeFileSync(path.join(root, "brewdocs.yml"), "themeFile: brand\n", "utf8");

    // Local: the repo's own key resolves the manifest.
    expect(resolveThemeRef(undefined, root).manifest).toBeTruthy();
    // Fetched: it does not.
    expect(resolveThemeRef(undefined, root, { fetched: true }).manifest).toBeUndefined();
  });

  it("a built-in name stays built-in even when a manifest file matches it", () => {
    const root = repoWithTheme({ name: "coffee", theme: "coffee", marker: "alert(0)" });

    // Every bundled name is protected, not just the one the probe used.
    for (const name of ["coffee", "ink", "matcha", "newsprint"]) {
      expect(isBuiltinTheme(name)).toBe(true);
    }
    expect(loadThemeManifest("coffee", root)).toBeNull();
  });
});
