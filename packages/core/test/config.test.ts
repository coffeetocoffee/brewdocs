import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { loadConfig, __resetConfigWarnings } from "@brewdocs/core";

function tmp(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "brewdocs-cfg-"));
}

describe("loadConfig", () => {
  it("returns empty config when no file exists", () => {
    const dir = tmp();
    expect(loadConfig(dir)).toEqual({});
  });

  it("parses brewdocs.yml with a nested s3 block", () => {
    const dir = tmp();
    fs.writeFileSync(
      path.join(dir, "brewdocs.yml"),
      [
        "theme: ink",
        "dark: true",
        "name: mydocs",
        "multi: true",
        "storage: s3",
        "s3:",
        "  bucket: my-bucket",
        "  region: auto",
        "  endpoint: https://x.r2.cloudflarestorage.com",
      ].join("\n"),
    );
    const cfg = loadConfig(dir);
    expect(cfg.theme).toBe("ink");
    expect(cfg.dark).toBe(true);
    expect(cfg.name).toBe("mydocs");
    expect(cfg.multi).toBe(true);
    expect(cfg.storage).toBe("s3");
    expect(cfg.s3?.bucket).toBe("my-bucket");
    expect(cfg.s3?.endpoint).toBe("https://x.r2.cloudflarestorage.com");
  });

  it("parses brewdocs.json", () => {
    const dir = tmp();
    fs.writeFileSync(
      path.join(dir, "brewdocs.json"),
      JSON.stringify({ theme: "matcha", name: "docs" }),
    );
    const cfg = loadConfig(dir);
    expect(cfg.theme).toBe("matcha");
    expect(cfg.name).toBe("docs");
  });

  it("prefers brewdocs.yml over brewdocs.json", () => {
    const dir = tmp();
    fs.writeFileSync(path.join(dir, "brewdocs.json"), JSON.stringify({ theme: "newsprint" }));
    fs.writeFileSync(path.join(dir, "brewdocs.yml"), "theme: coffee\n");
    expect(loadConfig(dir).theme).toBe("coffee");
  });
});

describe("loadConfig validation (warns, never throws)", () => {
  let warns: string[];
  let spy: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    __resetConfigWarnings();
    warns = [];
    spy = vi.spyOn(console, "warn").mockImplementation((...a: unknown[]) => {
      warns.push(a.join(" "));
    });
  });
  afterEach(() => spy.mockRestore());

  it("stays silent for a valid config", () => {
    const dir = tmp();
    fs.writeFileSync(path.join(dir, "brewdocs.yml"), "theme: ink\ndark: true\n");
    loadConfig(dir);
    expect(warns).toEqual([]);
  });

  it("warns on an unknown key, suggests the nearest, and drops it", () => {
    const dir = tmp();
    fs.writeFileSync(path.join(dir, "brewdocs.yml"), "them: ink\n");
    const cfg = loadConfig(dir);
    expect(warns.join("\n")).toMatch(/unknown key "them"/);
    expect(warns.join("\n")).toMatch(/did you mean "theme"/);
    expect(cfg).not.toHaveProperty("them");
    expect(cfg.theme).toBeUndefined();
  });

  it("warns on a wrong-typed value and falls back to the default", () => {
    const dir = tmp();
    fs.writeFileSync(path.join(dir, "brewdocs.yml"), 'dark: "no"\n');
    const cfg = loadConfig(dir);
    expect(warns.join("\n")).toMatch(/"dark" .*should be a boolean/);
    expect(cfg.dark).toBeUndefined();
  });

  it("warns and builds with defaults when the file cannot be parsed", () => {
    const dir = tmp();
    fs.writeFileSync(path.join(dir, "brewdocs.json"), "{ not valid json");
    expect(loadConfig(dir)).toEqual({});
    expect(warns.join("\n")).toMatch(/could not be parsed/);
  });
});

// v4.4: a key with a fixed set of values is a *string* to matchesKind, so
// `storage: lcoal` used to pass validation and then silently no-op.
describe("loadConfig validation — enum values", () => {
  let warns: string[];
  let spy: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    __resetConfigWarnings();
    warns = [];
    spy = vi.spyOn(console, "warn").mockImplementation((...a: unknown[]) => {
      warns.push(a.join(" "));
    });
  });
  afterEach(() => spy.mockRestore());

  it("warns and drops a typo'd storage value instead of silently going local", () => {
    const dir = tmp();
    fs.writeFileSync(path.join(dir, "brewdocs.yml"), "storage: lcoal\n");
    const cfg = loadConfig(dir);
    expect(warns.join("\n")).toMatch(/"storage" .*must be one of local, s3/);
    expect(cfg.storage).toBeUndefined();
  });

  it("accepts a valid storage value silently", () => {
    const dir = tmp();
    fs.writeFileSync(path.join(dir, "brewdocs.yml"), "storage: s3\n");
    expect(loadConfig(dir).storage).toBe("s3");
    expect(warns).toEqual([]);
  });

  it("warns on an unknown locale but accepts region/base forms", () => {
    const bad = tmp();
    fs.writeFileSync(path.join(bad, "brewdocs.yml"), "locale: xx\n");
    const badCfg = loadConfig(bad);
    expect(warns.join("\n")).toMatch(/"locale" .*must be one of/);
    expect(badCfg.locale).toBeUndefined();

    warns = [];
    const good = tmp();
    fs.writeFileSync(path.join(good, "brewdocs.yml"), "locale: id-ID\n");
    expect(loadConfig(good).locale).toBe("id-ID");
    expect(warns).toEqual([]);
  });

  it("warns once per problem, not once per loadConfig call", () => {
    const dir = tmp();
    fs.writeFileSync(path.join(dir, "brewdocs.yml"), "storage: lcoal\n");
    loadConfig(dir);
    loadConfig(dir);
    loadConfig(dir);
    expect(warns.filter((w) => /storage/.test(w))).toHaveLength(1);
  });
});
