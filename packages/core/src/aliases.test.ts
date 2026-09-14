import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  buildVersions,
  emitAliasPages,
  emitRedirects,
  isEolVersion,
  loadConfig,
  redirectHtml,
} from "@brewdocs/core";

function tmp(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

describe("v3.0 EOL + alias helpers", () => {
  it("matches exact versions and major.x patterns", () => {
    expect(isEolVersion("1.0.0", ["1.0.0"])).toBe(true);
    expect(isEolVersion("v1.0.0", ["1.0.0"])).toBe(true);
    expect(isEolVersion("1.0.0", ["v1.0.0"])).toBe(true);
    expect(isEolVersion("1.4.2", ["1.x"])).toBe(true);
    expect(isEolVersion("2.0.0", ["1.x"])).toBe(false);
    expect(isEolVersion("2.0.0", [])).toBe(false);
    expect(isEolVersion("2.0.0", undefined)).toBe(false);
  });

  it("redirect pages are meta-refresh with a canonical link", () => {
    const html = redirectHtml("./1.2.0/index.html", "latest → v1.2.0");
    expect(html).toContain('http-equiv="refresh"');
    expect(html).toContain('content="0; url=./1.2.0/index.html"');
    expect(html).toContain('rel="canonical"');
    expect(html).toContain("latest → v1.2.0");
  });

  it("emitAliasPages writes only aliases of built versions", () => {
    const out = tmp("brewdocs-alias-");
    fs.mkdirSync(path.join(out, "1.2.0"), { recursive: true });
    const written = emitAliasPages(
      out,
      ["1.2.0"],
      { latest: "1.2.0", "old": "0.9.0" },
      { eol: ["0.9"] },
    );
    expect(written).toHaveLength(1);
    expect(fs.existsSync(path.join(out, "latest", "index.html"))).toBe(true);
    expect(fs.existsSync(path.join(out, "old", "index.html"))).toBe(false);
    expect(fs.readFileSync(path.join(out, "latest", "index.html"), "utf8")).toContain(
      "../1.2.0/index.html",
    );
  });

  it("emitRedirects never clobbers a real page", () => {
    const out = tmp("brewdocs-redir-");
    fs.writeFileSync(path.join(out, "taken.html"), "<html>real</html>", "utf8");
    const written = emitRedirects(out, { "taken.html": "elsewhere.html", "gone.html": "now.html" });
    expect(written).toHaveLength(1);
    expect(fs.readFileSync(path.join(out, "taken.html"), "utf8")).toBe("<html>real</html>");
    expect(fs.readFileSync(path.join(out, "gone.html"), "utf8")).toContain("now.html");
  });
});

describe("v3.0 brewdocs.yml v3 keys", () => {
  it("parses aliases, eol and redirects", () => {
    const dir = tmp("brewdocs-cfg-v3-");
    fs.writeFileSync(
      path.join(dir, "brewdocs.yml"),
      [
        "theme: ink",
        "locale: id",
        "aliases:",
        "  latest: \"1.1.0\"",
        "  stable: 1.0.0",
        "eol:",
        "  - \"1.x\"",
        "  - 0.9.0",
        "redirects:",
        "  old/guide.html: content/guide.html",
      ].join("\n"),
    );
    const cfg = loadConfig(dir);
    expect(cfg.theme).toBe("ink");
    expect(cfg.locale).toBe("id");
    expect(cfg.aliases).toEqual({ latest: "1.1.0", stable: "1.0.0" });
    expect(cfg.eol).toEqual(["1.x", "0.9.0"]);
    expect(cfg.redirects).toEqual({ "old/guide.html": "content/guide.html" });
  });
});

describe("v3.0 build-all with aliases + EOL (git repo)", () => {
  it("writes alias pages, EOL banners and (EOL) switcher marks", async () => {
    const repo = tmp("brewdocs-v3-git-");
    const out = tmp("brewdocs-v3-out-");
    try {
      fs.writeFileSync(
        path.join(repo, "package.json"),
        JSON.stringify({ name: "lib", version: "1.0.0" }),
      );
      fs.writeFileSync(path.join(repo, "index.js"), "module.exports = { a: 1 };\n");
      const run = (args: string[]) =>
        execFileSync("git", args, { cwd: repo, stdio: "ignore" });
      run(["init"]);
      run(["config", "user.email", "t@example.com"]);
      run(["config", "user.name", "t"]);
      run(["add", "."]);
      run(["commit", "-m", "1.0.0"]);
      run(["tag", "1.0.0"]);
      fs.writeFileSync(
        path.join(repo, "package.json"),
        JSON.stringify({ name: "lib", version: "1.1.0" }),
      );
      run(["add", "."]);
      run(["commit", "-m", "1.1.0"]);
      run(["tag", "1.1.0"]);
      fs.writeFileSync(
        path.join(repo, "brewdocs.yml"),
        [
          "aliases:",
          "  latest: 1.1.0",
          "  stable: 1.0.0",
          "eol:",
          "  - \"1.0.0\"",
          "redirects:",
          "  old/api.html: index.html",
        ].join("\n"),
      );

      await buildVersions({ root: repo }, out);

      const old = fs.readFileSync(path.join(out, "1.0.0", "index.html"), "utf8");
      expect(old).toContain('class="eol-banner"');
      expect(old).toContain("(EOL)");
      const fresh = fs.readFileSync(path.join(out, "1.1.0", "index.html"), "utf8");
      expect(fresh).not.toContain('class="eol-banner"');

      expect(fs.readFileSync(path.join(out, "latest", "index.html"), "utf8")).toContain(
        "../1.1.0/index.html",
      );
      expect(fs.readFileSync(path.join(out, "stable", "index.html"), "utf8")).toContain(
        "../1.0.0/index.html",
      );
      expect(fs.readFileSync(path.join(out, "old", "api.html"), "utf8")).toContain(
        "url=index.html",
      );
    } finally {
      fs.rmSync(repo, { recursive: true, force: true });
      fs.rmSync(out, { recursive: true, force: true });
    }
  });
});
