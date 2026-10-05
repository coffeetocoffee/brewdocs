import { afterEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createServer, readGapReport } from "./server.js";
import { deploySite } from "@brewdocs/core";

let tmpDirs: string[] = [];

function tmpDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "brewdocs-mcphttp-"));
  tmpDirs.push(dir);
  return dir;
}

afterEach(() => {
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
