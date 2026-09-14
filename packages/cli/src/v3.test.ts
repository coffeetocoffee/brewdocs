import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { run } from "./index.js";

describe("v3.0 CLI commands", () => {
  let cwd: string;
  let tmp: string;

  beforeEach(() => {
    cwd = process.cwd();
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "brewdocs-v3-cli-"));
    process.chdir(tmp);
  });

  afterEach(() => {
    process.chdir(cwd);
    process.exitCode = 0;
  });

  const PLUGIN = `module.exports = { name: "stamp", onRender: (html) => html };\n`;

  it("registry publish -> search -> install -> remove round-trip", async () => {
    const reg = path.join(tmp, "reg");
    const plugin = path.join(tmp, "stamp.cjs");
    fs.writeFileSync(plugin, PLUGIN, "utf8");

    await run([
      "registry", "publish", plugin,
      "--name", "stamp", "--version", "0.1.0",
      "--description", "stamps pages", "--registry", reg,
    ]);
    expect(fs.existsSync(path.join(reg, ".registry.json"))).toBe(true);

    await run(["registry", "search", "stamp", "--registry", reg]);
    await run(["registry", "list", "--registry", reg, "--json"]);

    const source = path.join(tmp, "src");
    fs.mkdirSync(source, { recursive: true });
    await run(["registry", "install", "stamp", "--into", source, "--registry", reg]);
    expect(
      fs.existsSync(path.join(source, ".brewdocs", "plugins", "stamp.cjs")),
    ).toBe(true);

    await run(["registry", "remove", "stamp", "--registry", reg]);
    expect(
      JSON.parse(fs.readFileSync(path.join(reg, ".registry.json"), "utf8")).plugins,
    ).toEqual([]);
  });

  it("registry gallery writes a marketplace page", async () => {
    const reg = path.join(tmp, "reg");
    const plugin = path.join(tmp, "stamp.cjs");
    fs.writeFileSync(plugin, PLUGIN, "utf8");
    await run(["registry", "publish", plugin, "--name", "stamp", "--version", "1.0.0", "--registry", reg]);
    await run(["registry", "gallery", "--registry", reg, "--out", path.join(tmp, "shop")]);
    expect(fs.readFileSync(path.join(tmp, "shop", "index.html"), "utf8")).toContain("stamp");
  });

  it("build --locale localizes the rendered chrome", async () => {
    const src = path.join(tmp, "lib");
    fs.mkdirSync(src, { recursive: true });
    fs.writeFileSync(
      path.join(src, "package.json"),
      JSON.stringify({ name: "lib", version: "1.0.0", main: "index.js", description: "d" }),
    );
    fs.writeFileSync(path.join(src, "index.js"), "exports.go = function go(name) { return name; };\n");
    await run(["build", src, "--out", path.join(tmp, "dist-ja"), "--locale", "ja"]);
    const html = fs.readFileSync(path.join(tmp, "dist-ja", "index.html"), "utf8");
    expect(html).toContain('<html lang="ja"');
    expect(html).toContain("パラメータ");
  });

  it("audit passes a freshly brewed site and gates a poor one", async () => {
    const src = path.join(tmp, "lib");
    fs.mkdirSync(src, { recursive: true });
    fs.writeFileSync(
      path.join(src, "package.json"),
      JSON.stringify({ name: "lib", version: "1.0.0", main: "index.js", description: "d" }),
    );
    fs.writeFileSync(path.join(src, "index.js"), "exports.go = function go() {};\n");
    await run(["build", src, "--out", path.join(tmp, "dist")]);
    await run(["audit", path.join(tmp, "dist"), "--min-score", "100"]);
    expect(process.exitCode).not.toBe(1);

    const bad = path.join(tmp, "bad");
    fs.mkdirSync(bad, { recursive: true });
    fs.writeFileSync(
      path.join(bad, "index.html"),
      "<!doctype html><html><head></head><body><h4>skip</h4></body></html>",
      "utf8",
    );
    await run(["audit", bad, "--min-score", "100"]);
    expect(process.exitCode).toBe(1);
  });

  it("audit --json emits a machine-readable report", async () => {
    const site = path.join(tmp, "site");
    fs.mkdirSync(site, { recursive: true });
    fs.writeFileSync(
      path.join(site, "index.html"),
      "<!doctype html><html lang=\"en\"><head><title>t</title></head><body><h1>x</h1></body></html>",
      "utf8",
    );
    await run(["audit", site, "--json"]);
  });

  it("locales command runs without error", async () => {
    await run(["locales"]);
  });
});
