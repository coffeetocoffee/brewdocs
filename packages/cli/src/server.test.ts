import { describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createServer, resolveSite } from "./server.js";

function tmp(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "brewdocs-host-"));
  fs.mkdirSync(path.join(dir, "demo"), { recursive: true });
  fs.writeFileSync(path.join(dir, "demo", "index.html"), "<h1>demo</h1>");
  return dir;
}

describe("Phase 4 — hosting router", () => {
  it("routes /s/<sub>/ to the site index", () => {
    const hosting = tmp();
    const r = resolveSite("/s/demo/", undefined, hosting);
    expect(r?.subdomain).toBe("demo");
    expect(r?.filePath.endsWith(path.join("demo", "index.html"))).toBe(true);
  });

  it("routes virtual host <sub>.brewdocs.dev", () => {
    const hosting = tmp();
    const r = resolveSite("/", "demo.brewdocs.dev", hosting);
    expect(r?.subdomain).toBe("demo");
  });

  it("ignores non-site paths", () => {
    const hosting = tmp();
    expect(resolveSite("/api/build", "x.brewdocs.dev", hosting)).toBeNull();
    expect(resolveSite("/", "example.com", hosting)).toBeNull();
  });

  it("blocks path traversal", () => {
    const hosting = tmp();
    const r = resolveSite("/s/demo/../../etc/passwd", undefined, hosting);
    expect(r).toBeNull();
  });
});

describe("Phase 4 — hosting server auth", () => {
  it("requires a bearer token on /api/build when BREWDOCS_TOKEN is set", async () => {
    const hosting = fs.mkdtempSync(path.join(os.tmpdir(), "brewdocs-auth-"));
    const server = createServer(hosting, undefined, "secret");
    await new Promise<void>((r) => server.listen(0, r));
    const addr = server.address();
    const port = typeof addr === "object" && addr ? addr.port : 0;
    const base = `http://127.0.0.1:${port}`;
    const body = JSON.stringify({ source: path.resolve(process.cwd(), "examples/tiny") });

    const noToken = await fetch(`${base}/api/build`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body,
    });
    expect(noToken.status).toBe(401);

    const withToken = await fetch(`${base}/api/build`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer secret" },
      body,
    });
    expect(withToken.status).toBe(200);
    const json = (await withToken.json()) as { subdomain: string };
    expect(json.subdomain).toBeTruthy();

    server.close();
  });
});

describe("Phase 5 — hosted-tier protection", () => {
  it("rate limits repeated /api/build from the same client", async () => {
    const hosting = fs.mkdtempSync(path.join(os.tmpdir(), "brewdocs-rl-"));
    const server = createServer(hosting, undefined, undefined, {
      rateLimit: 1,
      rateWindowMs: 60000,
      maxConcurrentBuilds: 1,
      maxQueue: 1,
    });
    await new Promise<void>((r) => server.listen(0, r));
    const addr = server.address();
    const port = typeof addr === "object" && addr ? addr.port : 0;
    const base = `http://127.0.0.1:${port}`;
    const body = JSON.stringify({ source: path.resolve(process.cwd(), "examples/tiny") });

    const first = await fetch(`${base}/api/build`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body,
    });
    expect(first.status).toBe(200);

    const second = await fetch(`${base}/api/build`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body,
    });
    expect(second.status).toBe(429);
    expect(second.headers.get("retry-after")).toBeTruthy();

    server.close();
  });

  it("returns 503 when the build queue is exhausted", async () => {
    const hosting = fs.mkdtempSync(path.join(os.tmpdir(), "brewdocs-q-"));
    const server = createServer(hosting, undefined, undefined, {
      maxConcurrentBuilds: 0,
      maxQueue: 0,
    });
    await new Promise<void>((r) => server.listen(0, r));
    const addr = server.address();
    const port = typeof addr === "object" && addr ? addr.port : 0;
    const base = `http://127.0.0.1:${port}`;
    const body = JSON.stringify({ source: path.resolve(process.cwd(), "examples/tiny") });

    const res = await fetch(`${base}/api/build`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body,
    });
    expect(res.status).toBe(503);

    server.close();
  });
});
