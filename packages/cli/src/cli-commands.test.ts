import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { run, isLoopbackHost, serveStatic } from "./index.js";

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

// v4.6 finding #25: a private site is only gated if a token hash was stored.
// `private: true` in config used to set visibility without minting a token,
// so the manifest said "private" with nothing to check and the site served
// anonymously. Every private deploy must record a tokenHash.
describe("private deploys always mint an access token", () => {
  it("mints a tokenHash for `private: true` in config, not only for --private", async () => {
    const src = path.resolve(__dirname, "../../../examples/tiny");
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "brewdocs-privcfg-"));
    const srcCopy = path.join(root, "app");
    fs.cpSync(src, srcCopy, { recursive: true });
    fs.writeFileSync(path.join(srcCopy, "brewdocs.yml"), "private: true\n", "utf8");
    const hosting = path.join(root, "hosting");
    await run(["deploy", srcCopy, "--name", "tiny", "--out", hosting]);
    const manifest = JSON.parse(
      fs.readFileSync(path.join(hosting, "tiny", ".brewdocs.json"), "utf8"),
    ) as { visibility: string; tokenHash?: string };
    expect(manifest.visibility).toBe("private");
    expect(manifest.tokenHash).toMatch(/^[0-9a-f]{64}$/);
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

// v4.0 live reload: `preview --watch` serves an SSE endpoint and injects a
// reload script, so a rebuild refreshes the browser.
describe("preview live reload", () => {
  it("injects the reload script and pushes on reload()", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "brewdocs-live-"));
    fs.writeFileSync(path.join(dir, "index.html"), "<html><body>hi</body></html>");
    const { server, reload } = serveStatic(dir, 0, true);
    try {
      await new Promise<void>((resolve) =>
        server.listening ? resolve() : server.once("listening", () => resolve()),
      );
      const addr = server.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      const base = `http://127.0.0.1:${port}`;

      const html = await (await fetch(`${base}/`)).text();
      expect(html).toContain("/__brewdocs/live");
      expect(html).toContain("EventSource");

      const sse = await fetch(`${base}/__brewdocs/live`);
      expect(sse.headers.get("content-type")).toContain("text/event-stream");
      const reader = sse.body!.getReader();
      const decoder = new TextDecoder();
      expect(decoder.decode((await reader.read()).value)).toContain("retry");
      reload();
      expect(decoder.decode((await reader.read()).value)).toContain("reload");
      await reader.cancel();
    } finally {
      server.closeAllConnections?.();
      server.close();
    }
  });
});
