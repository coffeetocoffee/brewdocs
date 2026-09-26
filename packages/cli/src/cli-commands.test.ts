import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { run, isLoopbackHost } from "./index.js";

describe("Authoring DX commands", () => {
  let cwd: string;
  let tmp: string;

  beforeEach(() => {
    cwd = process.cwd();
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "brewdocs-init-"));
    process.chdir(tmp);
  });

  afterEach(() => {
    process.chdir(cwd);
  });

  it("brewdocs init scaffolds a brewdocs.yml", async () => {
    await run(["init"]);
    const file = path.join(tmp, "brewdocs.yml");
    expect(fs.existsSync(file)).toBe(true);
    const text = fs.readFileSync(file, "utf8");
    expect(text).toContain("theme:");
    expect(text).toContain("dark:");
  });

  it("brewdocs init refuses to overwrite an existing config", async () => {
    await run(["init"]);
    await expect(run(["init"])).rejects.toThrow(/already exists/);
  });

  it("brewdocs keys add/list/revoke manages the key store", async () => {
    await run(["keys", "add", "--hosting", tmp, "--label", "ci"]);
    const file = path.join(tmp, ".keys.json");
    expect(fs.existsSync(file)).toBe(true);
    await run(["keys", "list", "--hosting", tmp]);
    // revoke by reading the hash from the store
    const keys = JSON.parse(fs.readFileSync(file, "utf8"));
    await run(["keys", "revoke", keys[0].hash, "--hosting", tmp]);
    expect(JSON.parse(fs.readFileSync(file, "utf8"))).toHaveLength(0);
  });
});

// v3.9 finding #5: the CLI deploy path must slugify --name. Before the fix it
// passed the raw value through when no --org was set, so `--name ../ESCAPED`
// wrote the site outside the hosting directory.
describe("deploy subdomain safety", () => {
  it("slugifies --name so it cannot escape the hosting dir", async () => {
    const src = path.resolve(__dirname, "../../../examples/tiny");
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "brewdocs-deploy-"));
    const hosting = path.join(root, "hosting");
    await run(["deploy", src, "--name", "../ESCAPED", "--out", hosting]);
    expect(fs.existsSync(path.join(root, "ESCAPED"))).toBe(false);
    expect(fs.existsSync(path.join(hosting, "escaped", "index.html"))).toBe(true);
  });
});

// v3.5 security: `serve` binds loopback by default; anything else is treated
// as network-exposed and triggers the auth guard.
describe("serve host safety", () => {
  it("classifies loopback vs network bind addresses", () => {
    for (const h of ["127.0.0.1", "127.0.0.5", "localhost", "::1", "[::1]", "LOCALHOST"]) {
      expect(isLoopbackHost(h)).toBe(true);
    }
    for (const h of ["0.0.0.0", "::", "192.168.1.10", "example.com", ""]) {
      expect(isLoopbackHost(h)).toBe(false);
    }
  });
});
