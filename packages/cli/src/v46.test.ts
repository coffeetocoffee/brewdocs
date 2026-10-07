import { describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { createServer } from "./server.js";
import { serveStatic } from "./index.js";
import { addKey, validateKey } from "./keys.js";
import { deploySite } from "@brewdocs/core";

const EXAMPLES = path.resolve(__dirname, "../../../examples");
const tinyRoot = path.join(EXAMPLES, "tiny");

async function start(hosting: string, token?: string) {
  const server = createServer(hosting, undefined, token);
  await new Promise<void>((r) => server.listen(0, r));
  const addr = server.address();
  const port = typeof addr === "object" && addr ? addr.port : 0;
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
