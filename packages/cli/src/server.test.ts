import { describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createServer, resolveSite } from "./server.js";
import { deploySite, deriveSubdomain } from "@brewdocs/core";

const EXAMPLES = path.resolve(__dirname, "../../../examples");
const tinyRoot = path.join(EXAMPLES, "tiny");

function tmp(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "brewdocs-host-"));
  fs.mkdirSync(path.join(dir, "demo"), { recursive: true });
  fs.writeFileSync(path.join(dir, "demo", "index.html"), "<h1>demo</h1>");
  return dir;
}

async function start(hosting: string, token?: string) {
  const server = createServer(hosting, undefined, token);
  await new Promise<void>((r) => server.listen(0, r));
  const addr = server.address();
  const port = typeof addr === "object" && addr ? addr.port : 0;
  return { server, base: `http://127.0.0.1:${port}` };
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
  it(
    "requires a bearer token on /api/build when BREWDOCS_TOKEN is set",
    { timeout: 30_000 },
    async () => {
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
  it(
    "rate limits repeated /api/build from the same client",
    { timeout: 30_000 },
    async () => {
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

describe("Direction D — orgs, private docs, analytics", () => {
  it("routes org-namespaced subdomains via virtual host", () => {
    const hosting = tmp();
    expect(resolveSite("/", "acme--lib.brewdocs.dev", hosting)).toBeNull();
    fs.mkdirSync(path.join(hosting, "acme--lib"), { recursive: true });
    fs.writeFileSync(path.join(hosting, "acme--lib", "index.html"), "<h1>org</h1>");
    const r = resolveSite("/", "acme--lib.brewdocs.dev", hosting);
    expect(r?.subdomain).toBe("acme--lib");
  });

  it(
    "gates private sites behind a token on read",
    { timeout: 30_000 },
    async () => {
    const hosting = fs.mkdtempSync(path.join(os.tmpdir(), "brewdocs-priv-"));
    await deploySite(
      { root: tinyRoot, name: "priv" },
      hosting,
      "priv",
      {},
      undefined,
      { visibility: "private", token: "letmein" },
    );
    const { server, base } = await start(hosting, "admin");
    try {
      const noToken = await fetch(`${base}/s/priv/`);
      expect(noToken.status).toBe(401);

      const wrong = await fetch(`${base}/s/priv/?token=wrong`);
      expect(wrong.status).toBe(401);

      const withQuery = await fetch(`${base}/s/priv/?token=letmein`);
      expect(withQuery.status).toBe(200);

      const withHeader = await fetch(`${base}/s/priv/`, {
        headers: { authorization: "Bearer letmein" },
      });
      expect(withHeader.status).toBe(200);
    } finally {
      server.close();
    }
  });

  it(
    "counts pageviews and builds in /api/stats",
    { timeout: 30_000 },
    async () => {
    const hosting = fs.mkdtempSync(path.join(os.tmpdir(), "brewdocs-stats-"));
    const { server, base } = await start(hosting, "admin");
    try {
      const buildRes = await fetch(`${base}/api/build`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: "Bearer admin" },
        body: JSON.stringify({ source: tinyRoot, name: "stats-site" }),
      });
      expect(buildRes.status).toBe(200);

      await fetch(`${base}/s/stats-site/`);
      await fetch(`${base}/s/stats-site/`);

      const stats = (await (
        await fetch(`${base}/api/stats?site=stats-site`)
      ).json()) as { views: number; builds: number };
      expect(stats.views).toBe(2);
      expect(stats.builds).toBe(1);

      const all = (await (
        await fetch(`${base}/api/stats`, { headers: { authorization: "Bearer admin" } })
      ).json()) as Record<string, { builds: number }>;
      expect(all["stats-site"].builds).toBe(1);
    } finally {
      server.close();
    }
  });

  it("requires the admin token for the all-sites stats rollup", async () => {
    const hosting = fs.mkdtempSync(path.join(os.tmpdir(), "brewdocs-stats2-"));
    const { server, base } = await start(hosting, "admin");
    try {
      const noAuth = await fetch(`${base}/api/stats`);
      expect(noAuth.status).toBe(401);
      const withAuth = await fetch(`${base}/api/stats`, {
        headers: { authorization: "Bearer admin" },
      });
      expect(withAuth.status).toBe(200);
    } finally {
      server.close();
    }
  });

  it(
    "serves a GitHub-sourced site under the repo-user subdomain",
    { timeout: 30_000 },
    async () => {
    const hosting = fs.mkdtempSync(path.join(os.tmpdir(), "brewdocs-gh-"));
    const sub = deriveSubdomain({ root: tinyRoot, name: "https://github.com/user/repo" });
    expect(sub).toBe("repo-user");
    await deploySite({ root: tinyRoot, name: "https://github.com/user/repo" }, hosting, sub);
    const r = resolveSite("/s/repo-user/", undefined, hosting);
    expect(r?.subdomain).toBe("repo-user");
  });
});

describe("Launchable hosting — dashboard + cache", () => {
  it("serves an owner dashboard for a deployed site", async () => {
    const hosting = fs.mkdtempSync(path.join(os.tmpdir(), "brewdocs-dash-"));
    await deploySite({ root: tinyRoot, name: "dash" }, hosting, "dash");
    const { server, base } = await start(hosting, "admin");
    try {
      const res = await fetch(`${base}/dashboard?site=dash`);
      expect(res.status).toBe(200);
      const html = await res.text();
      expect(html).toContain("page views");
      expect(html).toContain("dash.brewdocs.dev");
    } finally {
      server.close();
    }
  });

  it("gates a private site's dashboard behind its token", async () => {
    const hosting = fs.mkdtempSync(path.join(os.tmpdir(), "brewdocs-dashp-"));
    await deploySite(
      { root: tinyRoot, name: "dashp" },
      hosting,
      "dashp",
      {},
      undefined,
      { visibility: "private", token: "owner" },
    );
    const { server, base } = await start(hosting, "admin");
    try {
      const noToken = await fetch(`${base}/dashboard?site=dashp`);
      expect(noToken.status).toBe(401);
      const ok = await fetch(`${base}/dashboard?site=dashp&token=owner`);
      expect(ok.status).toBe(200);
    } finally {
      server.close();
    }
  });

  it("sets no-cache on HTML and cache on assets", async () => {
    const hosting = fs.mkdtempSync(path.join(os.tmpdir(), "brewdocs-cache-"));
    await deploySite({ root: tinyRoot, name: "cache" }, hosting, "cache");
    const { server, base } = await start(hosting);
    try {
      const html = await fetch(`${base}/s/cache/`);
      expect(html.headers.get("cache-control")).toContain("no-cache");
    } finally {
      server.close();
    }
  });
});

describe("Per-user API keys", () => {
  it("requires a valid key once keys are configured", async () => {
    const hosting = fs.mkdtempSync(path.join(os.tmpdir(), "brewdocs-keysapi-"));
    // Seed a key store so the server enforces auth.
    await import("../src/keys.js").then((m) => m.addKey(hosting, { scopes: ["build"] }));

    const { server, base } = await start(hosting, "admin");
    try {
      const body = JSON.stringify({ source: tinyRoot });
      const noAuth = await fetch(`${base}/api/build`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body,
      });
      expect(noAuth.status).toBe(401);

      const admin = await fetch(`${base}/api/build`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: "Bearer admin" },
        body,
      });
      expect(admin.status).toBe(200);
    } finally {
      server.close();
    }
  });
});

describe("Markdown/MDX API", () => {
  it("POST /api/markdown returns a Markdown reference", async () => {
    const hosting = fs.mkdtempSync(path.join(os.tmpdir(), "brewdocs-mdapi-"));
    const { server, base } = await start(hosting);
    try {
      const res = await fetch(`${base}/api/markdown`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ source: tinyRoot, format: "md" }),
      });
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toContain("text/markdown");
      const text = await res.text();
      expect(text).toContain("#");
    } finally {
      server.close();
    }
  });
});
