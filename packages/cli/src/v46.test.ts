import { describe, expect, it } from "vitest";
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { createServer } from "./server.js";
import { listenLocal } from "./test-util.js";
import { serveStatic } from "./index.js";
import { addKey, validateKey } from "./keys.js";
import { deploySite } from "@brewdocs/core";

const EXAMPLES = path.resolve(__dirname, "../../../examples");
const tinyRoot = path.join(EXAMPLES, "tiny");

async function start(hosting: string, token?: string) {
  const server = createServer(hosting, undefined, token);
  // v4.7 finding #30: loopback only — a bare listen(0) binds every interface.
  const port = await listenLocal(server);
  return { server, base: `http://127.0.0.1:${port}`, port };
}

/** Send a raw request line the URL parser may reject, and read the status line. */
function rawRequest(port: number, requestLine: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const sock = net.connect(port, "127.0.0.1", () => {
      sock.write(`${requestLine}\r\nHost: x\r\nConnection: close\r\n\r\n`);
    });
    let buf = "";
    sock.on("data", (d) => (buf += d));
    sock.on("close", () => resolve(buf.split("\r\n")[0] ?? ""));
    sock.on("error", reject);
    setTimeout(() => {
      sock.destroy();
      reject(new Error("raw request timed out"));
    }, 5_000).unref();
  });
}

describe("v4.6 — the server survives hostile input (finding #21)", () => {
  it(
    "answers 400 to a request line that is not a URL, and stays up",
    { timeout: 60_000, retry: 2 },
    async () => {
      const hosting = fs.mkdtempSync(path.join(os.tmpdir(), "brewdocs-hostile-"));
      const { server, base, port } = await start(hosting, "admin");
      try {
        // `//[` makes `new URL()` throw. Before the guard this rejected the
        // async request handler with no handler attached and Node exited.
        const status = await rawRequest(port, "GET //[ HTTP/1.1");
        expect(status).toContain("400");

        // The process is still serving.
        const after = await fetch(`${base}/`);
        expect(after.status).toBe(200);
      } finally {
        server.close();
      }
    },
  );

  it(
    "answers 400 to a lone percent-escape in the preview server",
    { timeout: 60_000, retry: 2 },
    async () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), "brewdocs-prev-hostile-"));
      fs.writeFileSync(path.join(dir, "index.html"), "<h1>hi</h1>");
      const { server } = serveStatic(dir, 0);
      try {
        await new Promise<void>((r) =>
          server.listening ? r() : server.once("listening", () => r()),
        );
        const addr = server.address();
        const port = typeof addr === "object" && addr ? addr.port : 0;
        // `%` alone makes decodeURIComponent throw URIError.
        expect(await rawRequest(port, "GET /% HTTP/1.1")).toContain("400");
        expect(await rawRequest(port, "GET //[ HTTP/1.1")).toContain("400");
        const ok = await fetch(`http://127.0.0.1:${port}/`);
        expect(ok.status).toBe(200);
      } finally {
        server.close();
      }
    },
  );

  it(
    "survives a client that abandons a POST mid-body",
    { timeout: 60_000, retry: 2 },
    async () => {
      // Reading the body (`for await (const chunk of req)`) throws `aborted`
      // when the socket dies mid-request. That rejection is what the outer
      // guard exists for: unhandled, it exits the process.
      const hosting = fs.mkdtempSync(path.join(os.tmpdir(), "brewdocs-abort-"));
      const { server, base, port } = await start(hosting, undefined);
      try {
        await new Promise<void>((resolve) => {
          const sock = net.connect(port, "127.0.0.1", () => {
            sock.write(
              "POST /api/build HTTP/1.1\r\nHost: x\r\n" +
                "Content-Type: application/json\r\nContent-Length: 100\r\n\r\n" +
                '{"source":',
            );
            setTimeout(() => {
              sock.destroy();
              resolve();
            }, 100);
          });
        });
        // Give the handler a moment to hit the aborted read.
        await new Promise((r) => setTimeout(r, 300));
        const after = await fetch(`${base}/`);
        expect(after.status).toBe(200);
      } finally {
        server.close();
      }
    },
  );

  it(
    "answers 401 to a wrong-length site token instead of crashing",
    { timeout: 60_000, retry: 2 },
    async () => {
      const hosting = fs.mkdtempSync(path.join(os.tmpdir(), "brewdocs-len-"));
      await deploySite(
        { root: tinyRoot, name: "priv" },
        hosting,
        "priv",
        {},
        undefined,
        { visibility: "private", token: "letmein" },
      );
      const { server, base } = await start(hosting, undefined);
      try {
        // The sha256 comparison is the one crypto.timingSafeEqual would throw
        // on. A naive swap would 500 (or worse) here.
        const short = await fetch(`${base}/s/priv/?token=a`);
        expect(short.status).toBe(401);
        const long = await fetch(`${base}/s/priv/?token=${"a".repeat(500)}`);
        expect(long.status).toBe(401);
        const right = await fetch(`${base}/s/priv/?token=letmein`);
        expect(right.status).toBe(200);
      } finally {
        server.close();
      }
    },
  );
});

describe("v4.6 — credential comparison keeps its exact semantics", () => {
  it("still accepts the right admin token and rejects a near-miss", async () => {
    const hosting = fs.mkdtempSync(path.join(os.tmpdir(), "brewdocs-tok-"));
    const { server, base } = await start(hosting, "admin-secret");
    try {
      const ok = await fetch(`${base}/api/sites`, {
        headers: { authorization: "Bearer admin-secret" },
      });
      expect(ok.status).toBe(200);
      // Same length, differs in the last character.
      const nearMiss = await fetch(`${base}/api/sites`, {
        headers: { authorization: "Bearer admin-secreT" },
      });
      expect(nearMiss.status).toBe(401);
      // Wrong length.
      const short = await fetch(`${base}/api/sites`, {
        headers: { authorization: "Bearer admin" },
      });
      expect(short.status).toBe(401);
    } finally {
      server.close();
    }
  });

  it("still validates API keys by their stored hash", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "brewdocs-keycmp-"));
    const { key } = addKey(dir, { label: "ci" });
    expect(validateKey(dir, key)?.label).toBe("ci");
    expect(validateKey(dir, "bd_live_wrong")).toBeNull();
    expect(validateKey(dir, key.slice(0, -1))).toBeNull();
  });
});

describe("v4.6 — a site's gate survives a damaged manifest (findings #23/#24/#25/#26)", () => {
  const sha256 = (s: string) => crypto.createHash("sha256").update(s).digest("hex");

  /**
   * Hand-written site directories rather than real deploys: these tests are
   * about what the server does with a manifest's *contents*, and a full build
   * of examples/tiny costs ~30s each — three of them per fixture blew the
   * timeout under load without testing anything more. The files here are
   * byte-for-byte what deploySite leaves behind for the fields that matter.
   */
  function fixtureHost() {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), "brewdocs-gate-"));
    const hosting = path.join(base, "hosting");
    const site = (name: string, manifest: object) => {
      const dir = path.join(hosting, name);
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, "index.html"), `<h1>${name}</h1>`, "utf8");
      fs.writeFileSync(path.join(dir, ".brewdocs.json"), JSON.stringify(manifest, null, 2), "utf8");
      return dir;
    };
    site("secret", {
      subdomain: "secret",
      visibility: "private",
      tokenHash: sha256("hunter2"),
      title: "secret",
    });
    // `visibility: private` with no tokenHash: what a hand-edit (or a
    // pre-v4.6 CLI run with `private: true` in config) leaves behind.
    site("hashless", { subdomain: "hashless", visibility: "private", title: "hashless" });
    // A hand-dropped public directory: index.html, no manifest at all (D-12).
    fs.mkdirSync(path.join(hosting, "handdrop"));
    fs.writeFileSync(path.join(hosting, "handdrop", "index.html"), "<h1>hand</h1>", "utf8");
    // A traversal target outside the hosting dir, shaped like a site.
    const outside = path.join(base, "outside");
    fs.mkdirSync(outside);
    fs.writeFileSync(
      path.join(outside, ".brewdocs.json"),
      JSON.stringify({ subdomain: "outside", visibility: "public", title: "NOT A SITE" }),
      "utf8",
    );
    fs.writeFileSync(path.join(outside, "index.html"), "<h1>outside</h1>", "utf8");
    return { hosting, manifestPath: path.join(hosting, "secret", ".brewdocs.json") };
  }

  it(
    "refuses a site whose manifest exists but is truncated, on every route",
    { timeout: 60_000, retry: 2 },
    async () => {
      const { hosting, manifestPath } = await fixtureHost();
      // What a crash or a full disk mid-write leaves: valid prefix, no close.
      fs.writeFileSync(manifestPath, '{"subdomain":"secret","visibility":"pri', "utf8");
      const { server, base } = await start(hosting);
      try {
        // Before the fix every one of these answered 200 with the page.
        expect((await fetch(`${base}/s/secret/`)).status).toBe(500);
        expect((await fetch(`${base}/dashboard?site=secret`)).status).toBe(500);
        expect((await fetch(`${base}/api/stats?site=secret`)).status).toBe(500);
        expect(
          (
            await fetch(`${base}/mcp?site=secret`, {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
            })
          ).status,
        ).toBe(500);

        // The refusal is visible where an operator looks, not only on stderr.
        const sites = (await (await fetch(`${base}/api/sites`)).json()) as Array<{
          subdomain: string;
          visibility?: string;
        }>;
        expect(sites.find((s) => s.subdomain === "secret")?.visibility).toBe("private");

        // Repairing the file restores service without a restart.
        fs.writeFileSync(
          manifestPath,
          JSON.stringify({
            subdomain: "secret",
            visibility: "private",
            tokenHash: sha256("hunter2"),
            title: "secret",
          }),
          "utf8",
        );
        expect((await fetch(`${base}/s/secret/?token=hunter2`)).status).toBe(200);
        expect((await fetch(`${base}/s/secret/`)).status).toBe(401);
      } finally {
        server.close();
      }
    },
  );

  it(
    "a private manifest with no tokenHash is refused, not served (finding #25)",
    { timeout: 60_000, retry: 2 },
    async () => {
      const { hosting } = await fixtureHost();
      const { server, base } = await start(hosting);
      try {
        // `visibility: private` with no tokenHash used to read as public
        // because requireSiteAccess answered "no hash, so nothing to check".
        expect((await fetch(`${base}/s/hashless/`)).status).toBe(401);
        expect((await fetch(`${base}/dashboard?site=hashless`)).status).toBe(401);
        expect(
          (
            await fetch(`${base}/mcp?site=hashless`, {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
            })
          ).status,
        ).toBe(401);
      } finally {
        server.close();
      }
    },
  );

  it(
    "a hand-dropped directory with no manifest still serves (D-12)",
    { timeout: 60_000, retry: 2 },
    async () => {
      const { hosting } = await fixtureHost();
      const { server, base } = await start(hosting);
      try {
        // Absence stays benign on purpose: whoever can delete the manifest can
        // rewrite it, so "missing" is not the weakness "unreadable" is.
        expect((await fetch(`${base}/s/handdrop/`)).status).toBe(200);
      } finally {
        server.close();
      }
    },
  );

  it(
    "?site= cannot walk out of the hosting dir (finding #24)",
    { timeout: 60_000, retry: 2 },
    async () => {
      const { hosting } = await fixtureHost();
      const { server, base } = await start(hosting);
      try {
        const evil = encodeURIComponent("../outside");
        // /mcp used to build `hostingDir/../outside/docmodel.json` from the raw
        // parameter and answered 200; /dashboard rendered the outside title;
        // /api/stats read the outside manifest for access check.
        const mcp = await fetch(`${base}/mcp?site=${evil}`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
        });
        expect(mcp.status).toBe(404);
        const dash = await fetch(`${base}/dashboard?site=${evil}`);
        expect(dash.status).toBe(404);
        expect(await dash.text()).not.toContain("NOT A SITE");
        const stats = await fetch(`${base}/api/stats?site=${evil}`);
        expect([400, 404]).toContain(stats.status);

        // Bare dots and multiple traversal steps are refused across all query routes
        for (const dot of [encodeURIComponent(".."), encodeURIComponent("../../outside")]) {
          expect([400, 404]).toContain((await fetch(`${base}/dashboard?site=${dot}`)).status);
          expect([400, 404]).toContain((await fetch(`${base}/api/stats?site=${dot}`)).status);
          const mcpDot = await fetch(`${base}/mcp?site=${dot}`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
          });
          expect([400, 404]).toContain(mcpDot.status);
        }
      } finally {
        server.close();
      }
    },
  );

  it(
    "an unreadable key store counts as configured auth, not as none (finding #26)",
    { timeout: 60_000, retry: 2 },
    async () => {
      const hosting = fs.mkdtempSync(path.join(os.tmpdir(), "brewdocs-keys-"));
      const { key } = addKey(hosting, { label: "ci" }); // auth IS configured
      const first = await start(hosting);
      try {
        // Sanity: the configured key opens a read endpoint, no key is 401.
        expect(
          (await fetch(`${first.base}/api/sites`, { headers: { authorization: `Bearer ${key}` } }))
            .status,
        ).toBe(200);
        expect((await fetch(`${first.base}/api/sites`)).status).toBe(401);
      } finally {
        first.server.close();
      }
      // ...then the store is damaged. Before the fix `loadKeys` answered [],
      // `needsAuth` read that as "no auth", and every gated route went public.
      fs.writeFileSync(path.join(hosting, ".keys.json"), "[{", "utf8");
      const second = await start(hosting);
      try {
        expect((await fetch(`${second.base}/api/sites`)).status).toBe(401);
        expect(
          (
            await fetch(`${second.base}/api/build`, {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({ source: tinyRoot }),
            })
          ).status,
        ).toBe(401);
        // And the raw key cannot authenticate either: the store that would
        // verify it is exactly what is unreadable. Refuse until repaired.
        expect(
          (await fetch(`${second.base}/api/sites`, { headers: { authorization: `Bearer ${key}` } }))
            .status,
        ).toBe(401);
      } finally {
        second.server.close();
      }
    },
  );
});
