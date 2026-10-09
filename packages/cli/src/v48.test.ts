import { describe, expect, it, vi } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createServer } from "./server.js";
import { listenLocal } from "./test-util.js";
import { addKey, keyStoreState, keysConfigured, revokeKey } from "./keys.js";

/**
 * Finding #33: `needsAuth` was computed once inside buildRequestHandler, which
 * runs once at server construction — so a key issued against a *running*
 * server did not turn auth on, while the startup banner tells operators to run
 * `brewdocs keys add` to lock a network instance down. The read endpoint kept
 * answering 200 anonymously, and POST /api/build (an `npm install` of a
 * caller-supplied name) stayed open too.
 *
 * The contrast that made this a bug rather than a design choice: the domains
 * store is deliberately re-read per request because "domains can be added while
 * the server runs". Keys got no such treatment.
 */

const EXAMPLES = path.resolve(__dirname, "../../../examples");
const tinyRoot = path.join(EXAMPLES, "tiny");

async function start(hosting: string) {
  const server = createServer(hosting, undefined, undefined);
  const port = await listenLocal(server);
  return { server, base: `http://127.0.0.1:${port}` };
}

function tmpHosting(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "brewdocs-auth-live-"));
}

describe("v4.8 auth turns on against a running server (finding #33)", () => {
  it("starts open, refuses anonymously once a key is added, and accepts that key", async () => {
    const hosting = tmpHosting();
    const { server, base } = await start(hosting);
    try {
      // Before any key: an unauthenticated instance stays open (INV-16's
      // documented contract — the drop-in UI reads these).
      expect((await fetch(`${base}/api/sites`)).status).toBe(200);

      // A key is issued while the server is listening. No restart.
      const { key } = addKey(hosting, { label: "late" });

      expect((await fetch(`${base}/api/sites`)).status).toBe(401);
      expect(
        (await fetch(`${base}/api/sites`, { headers: { authorization: `Bearer ${key}` } })).status,
      ).toBe(200);
    } finally {
      server.close();
    }
  });

  it("closes the write surface too, not only the reads", async () => {
    const hosting = tmpHosting();
    const { server, base } = await start(hosting);
    try {
      // Before any key the route is reachable (the guard lets it through; a bad
      // source then answers 403/400 rather than 401 — the point is "not 401").
      const open = await fetch(`${base}/api/export`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ source: path.join(hosting, "nope") }),
      });
      expect(open.status).not.toBe(401);

      addKey(hosting, { label: "late" });

      // The write APIs are the RCE and file-disclosure surface (INV-19); they
      // must close the moment auth exists, without a restart.
      for (const route of ["/api/build", "/api/export", "/api/markdown"]) {
        const refused = await fetch(`${base}${route}`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ source: tinyRoot }),
        });
        expect(refused.status, `${route} should be 401`).toBe(401);
      }
    } finally {
      server.close();
    }
  });

  it("gates /mcp once a key exists", async () => {
    const hosting = tmpHosting();
    const { server, base } = await start(hosting);
    try {
      const site = path.join(hosting, "lib");
      fs.mkdirSync(site, { recursive: true });
      fs.writeFileSync(path.join(site, "index.html"), "<h1>lib</h1>", "utf8");
      fs.writeFileSync(
        path.join(site, ".brewdocs.json"),
        JSON.stringify({ subdomain: "lib", visibility: "public" }),
        "utf8",
      );

      addKey(hosting, { label: "late" });

      const mcp = await fetch(`${base}/mcp?site=lib`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
      });
      expect(mcp.status).toBe(401);
    } finally {
      server.close();
    }
  });

  it("revoking the last key returns the instance to its unauthenticated posture", async () => {
    const hosting = tmpHosting();
    const { key } = addKey(hosting, { label: "temp" });
    const { server, base } = await start(hosting);
    try {
      expect(
        (await fetch(`${base}/api/sites`, { headers: { authorization: `Bearer ${key}` } })).status,
      ).toBe(200);

      revokeKey(hosting, key);

      // With no keys left there is nothing to enforce, so the instance is open
      // again — presenting the revoked key changes nothing, exactly as it would
      // change nothing after a restart. The property under test is that the live
      // server and a freshly constructed one agree at every instant.
      expect((await fetch(`${base}/api/sites`)).status).toBe(200);
      expect(
        (await fetch(`${base}/api/sites`, { headers: { authorization: `Bearer ${key}` } })).status,
      ).toBe(200);

      // And it re-arms: one more key closes it again, no restart.
      const { key: second } = addKey(hosting, { label: "again" });
      expect((await fetch(`${base}/api/sites`)).status).toBe(401);
      expect(
        (await fetch(`${base}/api/sites`, { headers: { authorization: `Bearer ${second}` } })).status,
      ).toBe(200);
    } finally {
      server.close();
    }
  });

  it("announces the transition once, so the refusal is not mistaken for a bug", async () => {
    const hosting = tmpHosting();
    const { server, base } = await start(hosting);
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      addKey(hosting, { label: "late" });

      await fetch(`${base}/api/sites`);
      await fetch(`${base}/api/sites`);
      await fetch(`${base}/api/build`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ source: tinyRoot }),
      });

      const announcements = err.mock.calls
        .map((c) => String(c[0]))
        .filter((m) => m.includes("auth is now enforced"));
      expect(announcements).toHaveLength(1);
    } finally {
      err.mockRestore();
      server.close();
    }
  });

  it("a damaged store still refuses, and repairing it restores service", async () => {
    const hosting = tmpHosting();
    addKey(hosting, { label: "ci" });
    const { server, base } = await start(hosting);
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      fs.writeFileSync(path.join(hosting, ".keys.json"), "[{", "utf8");

      // Unreadable counts as configured (finding #26), re-evaluated per request.
      expect((await fetch(`${base}/api/sites`)).status).toBe(401);

      // Repairing the store restores service without a restart. The original
      // key's hash is unrecoverable from the truncated file — that is the
      // point of failing closed — so a fresh key proves the recovery path.
      const { key: fresh } = addKey(hosting, { label: "ci" });
      expect(
        (await fetch(`${base}/api/sites`, { headers: { authorization: `Bearer ${fresh}` } })).status,
      ).toBe(200);
      expect((await fetch(`${base}/api/sites`)).status).toBe(401);
    } finally {
      err.mockRestore();
      server.close();
    }
  });
});

describe("v4.8 keyStoreState reports the three states distinctly", () => {
  it("missing, empty, configured, unreadable", () => {
    const hosting = tmpHosting();
    expect(keyStoreState(hosting)).toBe("missing");
    expect(keysConfigured(hosting)).toBe(false);

    fs.writeFileSync(path.join(hosting, ".keys.json"), "[]", "utf8");
    expect(keyStoreState(hosting)).toBe("empty");
    expect(keysConfigured(hosting)).toBe(false);

    addKey(hosting, { label: "one" });
    expect(keyStoreState(hosting)).toBe("configured");
    expect(keysConfigured(hosting)).toBe(true);

    fs.writeFileSync(path.join(hosting, ".keys.json"), "[{", "utf8");
    expect(keyStoreState(hosting)).toBe("unreadable");
    // An unreadable store is auth configured but unverifiable (finding #26).
    expect(keysConfigured(hosting)).toBe(true);

    // A store that parses but is not an array is unreadable, not empty.
    fs.writeFileSync(path.join(hosting, ".keys.json"), "{}", "utf8");
    expect(keyStoreState(hosting)).toBe("unreadable");
    expect(keysConfigured(hosting)).toBe(true);
  });
});
