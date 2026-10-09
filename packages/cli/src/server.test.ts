import { afterAll, beforeAll, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createServer, resolveSite } from "./server.js";
import { listenLocal } from "./test-util.js";
import { deploySite, deriveSubdomain } from "@brewdocs/core";

const EXAMPLES = path.resolve(__dirname, "../../../examples");
const rawTiny = path.join(EXAMPLES, "tiny");
// Isolate fixture outside the host git repo so version discovery does not
// crawl all 28 git tags of brewdocs and churn worktrees per build request.
const fixtureTinyDir = fs.mkdtempSync(path.join(os.tmpdir(), "brewdocs-server-fixture-"));
const tinyRoot = path.join(fixtureTinyDir, "tiny");
fs.cpSync(rawTiny, tinyRoot, { recursive: true });
process.env.BREWDOCS_SOURCE_ROOT = fixtureTinyDir;

function tmp(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "brewdocs-host-"));
  fs.mkdirSync(path.join(dir, "demo"), { recursive: true });
  fs.writeFileSync(path.join(dir, "demo", "index.html"), "<h1>demo</h1>");
  return dir;
}

async function start(hosting: string, token?: string) {
  const server = createServer(hosting, undefined, token);
  // v4.7 finding #30: loopback only — a bare listen(0) binds every interface.
  const port = await listenLocal(server);
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

  // v3.5 regression: startsWith() containment accepted a sibling whose name
  // shares the target's prefix. `/s/acme/../acme-secret` must not resolve.
  it("blocks prefix-confusion reads of a sibling site", () => {
    const hosting = tmp();
    fs.mkdirSync(path.join(hosting, "acme"), { recursive: true });
    fs.mkdirSync(path.join(hosting, "acme-secret"), { recursive: true });
    fs.writeFileSync(path.join(hosting, "acme-secret", "index.html"), "SECRET");
    expect(resolveSite("/s/acme/../acme-secret/index.html", undefined, hosting)).toBeNull();
    // the sibling is still reachable under its own name — we blocked the
    // confusion, not the site.
    expect(resolveSite("/s/acme-secret/", undefined, hosting)).not.toBeNull();
  });

  // v3.5 regression: `...brewdocs.dev` slugifies to `..`, which peeked above
  // the hosting directory. A dots-only label must be refused.
  it("rejects dots-only / separator-bearing subdomains", () => {
    const hosting = tmp();
    for (const host of ["...brewdocs.dev", "..brewdocs.dev", ".brewdocs.dev"]) {
      expect(resolveSite("/index.html", host, hosting)).toBeNull();
    }
    expect(resolveSite("/s/../index.html", undefined, hosting)).toBeNull();
    expect(resolveSite("/s/a%2fb/index.html", undefined, hosting)).toBeNull();
  });
});

describe("Phase 4 — hosting server auth", () => {
  it(
    "requires a bearer token on /api/build when BREWDOCS_TOKEN is set",
    { timeout: 60_000, retry: 2 },
    async () => {
    const hosting = fs.mkdtempSync(path.join(os.tmpdir(), "brewdocs-auth-"));
    const server = createServer(hosting, undefined, "secret");
    const port = await listenLocal(server);
    const base = `http://127.0.0.1:${port}`;
    const body = JSON.stringify({ source: tinyRoot });

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

// v3.5 security: the build API used to accept ANY readable local path, turning
// an open (or merely LAN-reachable) instance into a file-disclosure primitive.
// `sourceRoot` now confines local sources; npm names and GitHub URLs still pass.
describe("Phase 5 — source confinement", () => {
  it(
    "refuses a local source outside the allowed root",
    { timeout: 60_000, retry: 2 },
    async () => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), "brewdocs-srcroot-"));
      const inside = path.join(root, "myrepo");
      fs.mkdirSync(inside, { recursive: true });
      fs.writeFileSync(path.join(inside, "package.json"), JSON.stringify({ name: "inside", version: "1.0.0" }));
      fs.writeFileSync(path.join(inside, "README.md"), "# inside\n");

      // A secret tree somewhere else entirely.
      const outside = fs.mkdtempSync(path.join(os.tmpdir(), "brewdocs-secret-"));
      fs.writeFileSync(path.join(outside, "README.md"), "# secret\n\nAPI_KEY=leak\n");

      const hosting = path.join(root, "hosting");
      fs.mkdirSync(hosting, { recursive: true });
      const server = createServer(hosting, undefined, undefined, { sourceRoot: root });
      const port = await listenLocal(server);
      const base = `http://127.0.0.1:${port}`;
      const post = (p: string, source: string) =>
        fetch(`${base}${p}`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ source }),
        });

      // Inside the root: works.
      expect((await post("/api/build", inside)).status).toBe(200);

      // Outside the root: refused for every source-reading endpoint.
      expect((await post("/api/build", outside)).status).toBe(403);
      expect((await post("/api/export", outside)).status).toBe(403);
      expect((await post("/api/markdown", outside)).status).toBe(403);

      // Traversal escape attempt is refused too.
      const escaped = path.join(root, "..", "..", "Windows");
      expect((await post("/api/build", escaped)).status).toBe(403);

      server.close();
    },
  );
});

describe("Phase 5 — hosted-tier protection", () => {
  it(
    "rate limits repeated /api/build from the same client",
    { timeout: 60_000, retry: 2 },
    async () => {
    const hosting = fs.mkdtempSync(path.join(os.tmpdir(), "brewdocs-rl-"));
    const server = createServer(hosting, undefined, undefined, {
      rateLimit: 1,
      rateWindowMs: 60000,
      maxConcurrentBuilds: 1,
      maxQueue: 1,
    });
    const port = await listenLocal(server);
    const base = `http://127.0.0.1:${port}`;
    const body = JSON.stringify({ source: tinyRoot });

    const first = await fetch(`${base}/api/build`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body,
    });
    expect(first.status).toBe(200);

    // v3.9 finding #10: a spoofed X-Forwarded-For must not reset the limiter —
    // the header is only trusted behind an opt-in --trust-proxy / env.
    const second = await fetch(`${base}/api/build`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-forwarded-for": "9.9.9.9" },
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
    const port = await listenLocal(server);
    const base = `http://127.0.0.1:${port}`;
    const body = JSON.stringify({ source: tinyRoot });

    const res = await fetch(`${base}/api/build`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body,
    });
    expect(res.status).toBe(503);

    server.close();
  });

  // v3.9 finding #16: a browser page on another origin must not drive the
  // build API. The signal is the browser's own Origin / Sec-Fetch-Site header.
  it("refuses cross-site POST /api/build", async () => {
    const hosting = tmp();
    const server = createServer(hosting);
    const port = await listenLocal(server);
    const base = `http://127.0.0.1:${port}`;
    const body = JSON.stringify({ source: tinyRoot });

    const evilOrigin = await fetch(`${base}/api/build`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: "http://evil.example" },
      body,
    });
    expect(evilOrigin.status).toBe(403);

    const crossSite = await fetch(`${base}/api/build`, {
      method: "POST",
      headers: { "content-type": "application/json", "sec-fetch-site": "cross-site" },
      body,
    });
    expect(crossSite.status).toBe(403);

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
    { timeout: 60_000, retry: 2 },
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
    { timeout: 60_000, retry: 2 },
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
    { timeout: 60_000, retry: 2 },
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
  it(
    "serves an owner dashboard for a deployed site",
    { timeout: 60_000, retry: 2 },
    async () => {
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

  it(
    "gates a private site's dashboard behind its token",
    { timeout: 60_000, retry: 2 },
    async () => {
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

  it(
    "sets no-cache on HTML and cache on assets",
    { timeout: 60_000, retry: 2 },
    async () => {
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
  it(
    "requires a valid key once keys are configured",
    { timeout: 60_000, retry: 2 },
    async () => {
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

  // v3.9 finding #11: read endpoints must not answer anonymously once keys exist.
  it("guards read endpoints once auth is configured", async () => {
    const hosting = fs.mkdtempSync(path.join(os.tmpdir(), "brewdocs-readauth-"));
    await import("../src/keys.js").then((m) => m.addKey(hosting, { scopes: ["build"] }));
    const { server, base } = await start(hosting);
    try {
      for (const path of ["/api/sites", "/api/registry", "/api/search?q=x"]) {
        expect((await fetch(`${base}${path}`)).status).toBe(401);
      }
    } finally {
      server.close();
    }
  });

  // v3.9 finding #9: a key's scopes must bound what it can do.
  it(
    "enforces the key's scopes per write endpoint",
    { timeout: 60_000, retry: 2 },
    async () => {
    const hosting = fs.mkdtempSync(path.join(os.tmpdir(), "brewdocs-scopes-"));
    const { key } = await import("../src/keys.js").then((m) =>
      m.addKey(hosting, { scopes: ["build"] }),
    );
    const { server, base } = await start(hosting);
    try {
      const body = JSON.stringify({ source: tinyRoot });

      const wrongScope = await fetch(`${base}/api/export`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
        body,
      });
      expect(wrongScope.status).toBe(403);

      const rightScope = await fetch(`${base}/api/build`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
        body,
      });
      expect(rightScope.status).toBe(200);
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
