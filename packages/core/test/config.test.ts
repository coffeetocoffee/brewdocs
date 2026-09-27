import { describe, expect, it } from "vitest";
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
