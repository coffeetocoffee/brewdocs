import { afterEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createServer, readGapReport, StatsStore } from "./server.js";
import { deploySite } from "@brewdocs/core";

let tmpDirs: string[] = [];

function tmpDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "brewdocs-mcphttp-"));
  tmpDirs.push(dir);
  return dir;
}

afterEach(() => {
  StatsStore.__clearInstancesForTest();
  for (const dir of tmpDirs) fs.rmSync(dir, { recursive: true, force: true });
  tmpDirs = [];
});

/** A package with one documented export, so a search has something to find. */
function fixtureSource(): string {
  const root = tmpDir();
  fs.writeFileSync(
    path.join(root, "package.json"),
    JSON.stringify({ name: "cafe", version: "1.0.0", main: "index.js" }),
    "utf8",
  );
  fs.writeFileSync(
    path.join(root, "index.js"),
    `/** Brew a cup.\n * @param {string} kind - what to brew\n * @returns {string} the cup\n */\nexport function brew(kind) { return "cup of " + kind; }\n`,
    "utf8",
  );
  fs.writeFileSync(path.join(root, "README.md"), "# cafe\n\nDocs.\n", "utf8");
  return root;
}

async function start(hosting: string, token?: string) {
  const server = createServer(hosting, undefined, token);
  await new Promise<void>((r) => server.listen(0, r));
  const addr = server.address();
  const port = typeof addr === "object" && addr ? addr.port : 0;
  return { server, base: `http://127.0.0.1:${port}` };
}

function rpc(base: string, site: string, body: unknown, token?: string) {
  return fetch(`${base}/mcp?site=${site}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(body),
  });
}

const TOOLS_LIST = { jsonrpc: "2.0", id: 1, method: "tools/list" };

describe("v4.5 MCP over HTTP — POST /mcp", () => {
  it(
    "answers tools/list and tools/call against a deployed site's docmodel",
    { timeout: 60_000, retry: 2 },
    async () => {
      const hosting = tmpDir();
      await deploySite({ root: fixtureSource(), name: "cafe" }, hosting, "cafe");
      const { server, base } = await start(hosting);
      try {
        const list = await rpc(base, "cafe", TOOLS_LIST);
        expect(list.status).toBe(200);
        const listed = (await list.json()) as { result: { tools: Array<{ name: string }> } };
        expect(listed.result.tools.map((t) => t.name)).toContain("search_symbols");

        const call = await rpc(base, "cafe", {
          jsonrpc: "2.0",
          id: 2,
          method: "tools/call",
          params: { name: "search_symbols", arguments: { query: "brew" } },
        });
        expect(call.status).toBe(200);
        const called = (await call.json()) as { result: { content: [{ text: string }] } };
        expect(called.result.content[0].text).toContain("brew");
      } finally {
        await new Promise<void>((r) => server.close(() => r()));
      }
    },
  );

  it(
    "records a miss and surfaces it through gapReport and GET /api/gap",
    { timeout: 60_000, retry: 2 },
    async () => {
      const hosting = tmpDir();
      await deploySite({ root: fixtureSource(), name: "cafe" }, hosting, "cafe");
      const { server, base } = await start(hosting);
      try {
        // Two agents ask for a symbol the docs do not have.
        for (let i = 0; i < 2; i++) {
          await rpc(base, "cafe", {
            jsonrpc: "2.0",
            id: i,
            method: "tools/call",
            params: { name: "search_symbols", arguments: { query: "espresso" } },
          });
        }
        // One finds what it wanted; that must not appear in the gap report.
        await rpc(base, "cafe", {
          jsonrpc: "2.0",
          id: 9,
          method: "tools/call",
          params: { name: "search_symbols", arguments: { query: "brew" } },
        });

        const gaps = readGapReport(hosting, "cafe");
        expect(gaps).toHaveLength(1);
        expect(gaps[0]).toMatchObject({ query: "espresso", misses: 2, site: "cafe" });

        const api = await fetch(`${base}/api/gap?site=cafe`);
        expect(api.status).toBe(200);
        const body = (await api.json()) as { gaps: Array<{ query: string }> };
        expect(body.gaps.map((g) => g.query)).toEqual(["espresso"]);
      } finally {
        await new Promise<void>((r) => server.close(() => r()));
      }
    },
  );

  it("rejects a missing site (400) and an unknown site (404)", async () => {
    const hosting = tmpDir();
    fs.mkdirSync(path.join(hosting, "cafe"), { recursive: true });
    const { server, base } = await start(hosting);
    try {
      const missing = await fetch(`${base}/mcp`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(TOOLS_LIST),
      });
      expect(missing.status).toBe(400);

      const unknown = await rpc(base, "ghost", TOOLS_LIST);
      expect(unknown.status).toBe(404);
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
    }
  });

  it(
    "requires auth once a token is configured",
    { timeout: 60_000, retry: 2 },
    async () => {
      const hosting = tmpDir();
      await deploySite({ root: fixtureSource(), name: "cafe" }, hosting, "cafe");
      const { server, base } = await start(hosting, "s3cret");
      try {
        const anon = await rpc(base, "cafe", TOOLS_LIST);
        expect(anon.status).toBe(401);
        const authed = await rpc(base, "cafe", TOOLS_LIST, "s3cret");
        expect(authed.status).toBe(200);
      } finally {
        await new Promise<void>((r) => server.close(() => r()));
      }
    },
  );

  it(
    "gates a private site's docmodel behind its access token",
    { timeout: 60_000, retry: 2 },
    async () => {
      const hosting = tmpDir();
      await deploySite(
        { root: fixtureSource(), name: "priv" },
        hosting,
        "priv",
        {},
        undefined,
        { visibility: "private", token: "letmein" },
      );
      const { server, base } = await start(hosting);
      try {
        const anon = await rpc(base, "priv", TOOLS_LIST);
        expect(anon.status).toBe(401);
        const authed = await rpc(base, "priv", TOOLS_LIST, "letmein");
        expect(authed.status).toBe(200);
      } finally {
        await new Promise<void>((r) => server.close(() => r()));
      }
    },
  );
});

describe("StatsStore hardening", () => {
  it("caps query key space, truncates long queries, and prioritizes misses upon eviction", () => {
    const file = path.join(tmpDir(), ".analytics.json");
    const store = new StatsStore(file);

    // Record 20 queries with misses
    for (let i = 0; i < 20; i++) {
      store.recordToolCall("cafe", { tool: "search_symbols", query: `miss-${i}`, hits: 0 });
    }

    // Record 280 queries with hits (total queries recorded = 300 > cap of 250)
    for (let i = 0; i < 280; i++) {
      store.recordToolCall("cafe", { tool: "search_symbols", query: `hit-${i}`, hits: 1 });
    }

    // Record a 1000-character query
    const longQuery = "q".repeat(1000);
    store.recordToolCall("cafe", { tool: "search_symbols", query: longQuery, hits: 0 });

    const stats = store.get("cafe") as any;
    const queryKeys = Object.keys(stats.queries || {});

    // Must be strictly capped at 250
    expect(queryKeys.length).toBeLessThanOrEqual(250);

    // The long query was truncated to 256 characters
    const truncatedKey = `search_symbols\u0000${"q".repeat(256)}`;
    expect(stats.queries[truncatedKey]).toBeDefined();

    // The misses must have been prioritized during eviction
    const gap = store.gapReport("cafe", 50);
    expect(gap.length).toBeGreaterThanOrEqual(20);
    for (let i = 0; i < 20; i++) {
      expect(gap.some((g) => g.query === `miss-${i}`)).toBe(true);
    }
  });

  it("debounces writes to disk and flushes atomically", () => {
    const file = path.join(tmpDir(), ".analytics.json");
    const store = new StatsStore(file);

    store.recordView("cafe", "/home");
    // Should not write synchronously
    expect(fs.existsSync(file)).toBe(false);

    // Explicit flush writes atomically
    store.flush();
    expect(fs.existsSync(file)).toBe(true);
    const content = JSON.parse(fs.readFileSync(file, "utf8"));
    expect(content.cafe.views).toBe(1);
  });

  it("caps path keys and prioritizes most-viewed paths", () => {
    const file = path.join(tmpDir(), ".analytics.json");
    const store = new StatsStore(file);

    // Frequent page
    for (let i = 0; i < 50; i++) {
      store.recordView("cafe", "/popular");
    }

    // 300 unique infrequent pages
    for (let i = 0; i < 300; i++) {
      store.recordView("cafe", `/page-${i}`);
    }

    const stats = store.get("cafe") as any;
    const paths = Object.keys(stats.paths || {});
    expect(paths.length).toBeLessThanOrEqual(250);

    // /popular was retained and is top path
    const top = store.topPaths("cafe", 5);
    expect(top[0].path).toBe("/popular");
    expect(top[0].views).toBe(50);
  });
});
