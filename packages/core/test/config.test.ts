import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { loadConfig } from "@brewdocs/core";

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
