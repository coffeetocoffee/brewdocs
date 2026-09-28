import { describe, expect, it, vi } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { build, loadPlugins } from "@brewdocs/core";

/**
 * Finding #19 / INV-20: a plugin is arbitrary code (require/import, no
 * signature, no sandbox) and the specifier is read from the source's own
 * brewdocs.yml. BrewDocs' stated threat model is rendering repos you do not
 * own, so a fetched (npm/git) source must never get to choose code that runs
 * on the operator's machine. Same rule as INV-17, which already refuses the
 * python adapter for exactly this reason.
 */

const MARKER = "plugin-code-executed";

/** A repo whose brewdocs.yml names a plugin that writes a marker file. */
function repoWithPlugin(): { root: string; marker: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "brewdocs-plugin-"));
  const marker = path.join(root, MARKER);
  fs.writeFileSync(
    path.join(root, "pwn.cjs"),
    `require("fs").writeFileSync(${JSON.stringify(marker)}, "executed");\n` +
      "module.exports = { adapters: [], onRender: (h) => h };\n",
  );
  fs.writeFileSync(path.join(root, "brewdocs.yml"), "plugins:\n  - ./pwn.cjs\n");
  fs.writeFileSync(
    path.join(root, "index.js"),
    "/** A library. */\nfunction add(a, b) { return a + b; }\nmodule.exports = { add };\n",
  );
  return { root, marker };
}

const outDir = (): string => fs.mkdtempSync(path.join(os.tmpdir(), "brewdocs-out-"));

describe("v4.4 fetched sources cannot name their own plugins (finding #19)", () => {
  it("refuses to load a plugin named in a fetched source's brewdocs.yml", () => {
    const { root, marker } = repoWithPlugin();

    build({ root, fetched: true }, outDir());

    expect(fs.existsSync(marker)).toBe(false);
  });

  it("warns that it ignored the repo's plugins, once, naming the count", () => {
    const { root } = repoWithPlugin();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    try {
      build({ root, fetched: true }, outDir());

      const pluginWarnings = warn.mock.calls
        .map((c) => String(c[0]))
        .filter((m) => m.includes("brewdocs.yml"));
      expect(pluginWarnings).toHaveLength(1);
      expect(pluginWarnings[0]).toContain("1 plugin(s)");
      // The message must point at the supported escape hatch.
      expect(pluginWarnings[0]).toContain("--plugins");
    } finally {
      warn.mockRestore();
    }
  });

  it("still builds the site — the plugin is dropped, not the build", () => {
    const { root } = repoWithPlugin();
    const out = outDir();

    const file = build({ root, fetched: true }, out);

    expect(fs.existsSync(file)).toBe(true);
    expect(fs.readFileSync(file, "utf8")).toContain("<!doctype html>");
  });

  it("honours a plugin the operator passed explicitly, even for a fetched source", () => {
    const { root, marker } = repoWithPlugin();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    try {
      // --plugins is the caller's own choice, not the repo's: it must survive.
      // The CLI resolves --plugins names to plugin objects before they reach
      // build() (see cli/src/index.ts), so the escape hatch is a loaded plugin.
      const explicit = loadPlugins(["./pwn.cjs"], root);
      expect(explicit).toHaveLength(1);

      build({ root, fetched: true }, outDir(), { plugins: explicit });

      expect(fs.existsSync(marker)).toBe(true);
    } finally {
      warn.mockRestore();
    }
  });

  it("loads a plugin from a locally chosen source (the feature is preserved)", () => {
    const { root, marker } = repoWithPlugin();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    try {
      build({ root }, outDir());

      expect(fs.existsSync(marker)).toBe(true);
      expect(warn.mock.calls.map((c) => String(c[0])).some((m) => m.includes("brewdocs.yml"))).toBe(
        false,
      );
    } finally {
      warn.mockRestore();
    }
  });

  it("is not warned about when a fetched source names no plugins", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "brewdocs-noplug-"));
    fs.writeFileSync(path.join(root, "index.js"), "function add(a, b) { return a + b; }\nmodule.exports={add};\n");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    try {
      build({ root, fetched: true }, outDir());

      expect(warn.mock.calls.map((c) => String(c[0])).some((m) => m.includes("brewdocs.yml"))).toBe(
        false,
      );
    } finally {
      warn.mockRestore();
    }
  });
});
