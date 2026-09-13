import { describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createServer } from "./server.js";
import { addOrgMember, createOrg, deploySite } from "@brewdocs/core";
import { addKey } from "./keys.js";

const EXAMPLES = path.resolve(__dirname, "../../../examples");
const tinyRoot = path.join(EXAMPLES, "tiny");

async function start(hosting: string, token?: string) {
  const server = createServer(hosting, undefined, token);
  await new Promise<void>((r) => server.listen(0, r));
  const addr = server.address();
  const port = typeof addr === "object" && addr ? addr.port : 0;
  return { server, base: `http://127.0.0.1:${port}` };
}

describe("v2.5 cloud control plane — org-gated private docs", () => {
  it(
    "lets org members read a private org site with their API key",
    { timeout: 60_000, retry: 2 },
    async () => {
      const hosting = fs.mkdtempSync(path.join(os.tmpdir(), "brewdocs-org-"));
      createOrg(hosting, "acme");
      const { key: memberKey } = addKey(hosting, { scopes: ["build"] });
      addOrgMember(hosting, "acme", memberKey);
      const { key: outsiderKey } = addKey(hosting, { scopes: ["build"] });

      await deploySite(
        { root: tinyRoot, name: "acmelib" },
        hosting,
        "acme--acmelib",
        {},
        undefined,
        { org: "acme", visibility: "private", token: "site-secret" },
      );
      const { server, base } = await start(hosting, "admin");
      try {
        const noAuth = await fetch(`${base}/s/acme--acmelib/`);
        expect(noAuth.status).toBe(401);

        const outsider = await fetch(`${base}/s/acme--acmelib/`, {
          headers: { authorization: `Bearer ${outsiderKey}` },
        });
        expect(outsider.status).toBe(401);

        const member = await fetch(`${base}/s/acme--acmelib/`, {
          headers: { authorization: `Bearer ${memberKey}` },
        });
        expect(member.status).toBe(200);

        const siteToken = await fetch(`${base}/s/acme--acmelib/?token=site-secret`);
        expect(siteToken.status).toBe(200);
      } finally {
        server.close();
      }
    },
  );
});

describe("v2.5 cloud control plane — analytics", () => {
  it(
    "tracks per-path views and serves an org rollup",
    { timeout: 60_000, retry: 2 },
    async () => {
      const hosting = fs.mkdtempSync(path.join(os.tmpdir(), "brewdocs-an-"));
      createOrg(hosting, "acme");
      await deploySite({ root: tinyRoot, name: "web" }, hosting, "web", {}, undefined, {
        org: "acme",
      });
      const { server, base } = await start(hosting, "admin");
      try {
        await fetch(`${base}/s/web/`);
        await fetch(`${base}/s/web/symbols/x.html`).catch(() => undefined);

        const stats = (await (
          await fetch(`${base}/api/stats?site=web`)
        ).json()) as {
          views: number;
          topPaths: Array<{ path: string; views: number }>;
        };
        expect(stats.views).toBeGreaterThanOrEqual(1);
        expect(stats.topPaths.some((p) => p.path === "/s/web/")).toBe(true);

        const noAuth = await fetch(`${base}/api/stats?org=acme`);
        expect(noAuth.status).toBe(401);

        const rollup = (await (
          await fetch(`${base}/api/stats?org=acme`, {
            headers: { authorization: "Bearer admin" },
          })
        ).json()) as { sites: string[]; views: number; builds: number };
        expect(rollup.sites).toContain("web");
        expect(rollup.views).toBeGreaterThanOrEqual(stats.views);
      } finally {
        server.close();
      }
    },
  );
});
