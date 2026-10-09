import { describe, expect, it, vi } from "vitest";
import * as fs from "node:fs";
import * as http from "node:http";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { MAX_BODY_BYTES, createServer, numOption } from "./server.js";
import { listenLocal } from "./test-util.js";

/**
 * v4.7 — three findings from the external handout, all reproduced before
 * being fixed:
 *   #28 every POST route read its body unbounded (`body += chunk`);
 *   #29 `BREWDOCS_RATE_LIMIT=` (empty) read as 0 and bricked the routes;
 *   #30 the test suite itself bound every interface (a bare `listen(0)`).
 * The behaviors, not the code shapes, are asserted here — the gate checks the
 * shapes (inv-31/32/33).
 */

async function start(hosting: string) {
  const server = createServer(hosting);
  const port = await listenLocal(server);
  return { server, base: `http://127.0.0.1:${port}`, port };
}

/** A hosting dir with one public site, so /mcp clears its manifest read. */
function fixtureHosting(): string {
  const hosting = fs.mkdtempSync(path.join(os.tmpdir(), "brewdocs-body-"));
  const dir = path.join(hosting, "lib");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "index.html"), "<h1>lib</h1>", "utf8");
  fs.writeFileSync(
    path.join(dir, ".brewdocs.json"),
    JSON.stringify({ subdomain: "lib", visibility: "public" }),
    "utf8",
  );
  return hosting;
}

/** Parse the status line out of a raw HTTP response buffer. */
function statusOf(buf: string): number {
  return Number(/^HTTP\/1\.1 (\d+)/.exec(buf.split("\r\n")[0] ?? "")?.[1] ?? 0);
}

/**
 * Raw chunked POST. fetch always sets a content-length for a string body, so
 * the no-content-length path needs a hand-written request.
 */
function chunkedPost(
  port: number,
  chunks: string[],
  pathName = "/api/build",
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const sock = net.connect(port, "127.0.0.1", () => {
      sock.write(
        `POST ${pathName} HTTP/1.1\r\nHost: x\r\nTransfer-Encoding: chunked\r\n` +
          `Content-Type: application/json\r\nConnection: close\r\n\r\n`,
      );
      for (const c of chunks) sock.write(`${Buffer.byteLength(c).toString(16)}\r\n${c}\r\n`);
      sock.write("0\r\n\r\n");
    });
    let buf = "";
    sock.on("data", (d) => (buf += d));
    sock.on("close", () => {
      const [head, ...rest] = buf.split("\r\n\r\n");
      resolve({ status: statusOf(head ?? ""), body: rest.join("\r\n\r\n") });
    });
    sock.on("error", reject);
    setTimeout(() => {
      sock.destroy();
      reject(new Error("chunked request timed out"));
    }, 15_000).unref();
  });
}

/** POST headers declaring a huge content-length, then send nothing. */
function headerOnlyPost(port: number, pathName: string, contentLength: number): Promise<number> {
  return new Promise((resolve, reject) => {
    const sock = net.connect(port, "127.0.0.1", () => {
      sock.write(
        `POST ${pathName} HTTP/1.1\r\nHost: x\r\nContent-Length: ${contentLength}\r\n` +
          `Content-Type: application/json\r\nConnection: close\r\n\r\n`,
      );
    });
    let buf = "";
    sock.on("data", (d) => {
      buf += d;
      if (buf.includes("\r\n")) {
        sock.destroy();
        resolve(statusOf(buf));
      }
    });
    sock.on("error", reject);
    setTimeout(() => {
      sock.destroy();
      reject(new Error("header-only request timed out"));
    }, 10_000).unref();
  });
}

describe("v4.7 — POST bodies are capped (finding #28)", () => {
  it(
    "answers 413 to an over-cap content-length on every POST route",
    { timeout: 60_000 },
    async () => {
      const { server, base } = await start(fixtureHosting());
      try {
        const payload = JSON.stringify({ source: "x", pad: "x".repeat(MAX_BODY_BYTES + 64 * 1024) });
        const post = (route: string) =>
          fetch(`${base}${route}`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: payload,
          });
        for (const route of ["/api/build", "/api/export", "/api/markdown"]) {
          const res = await post(route);
          expect(res.status, route).toBe(413);
          expect(((await res.json()) as { error: string }).error).toBe("payload too large");
        }
        // /mcp takes the same path once its manifest read has passed.
        expect((await post("/mcp?site=lib")).status).toBe(413);

        // The process survived all four: the next request is served normally.
        expect((await fetch(`${base}/`)).status).toBe(200);
      } finally {
        server.close();
      }
    },
  );

  it(
    "answers 413 to a chunked body with no content-length",
    { timeout: 60_000 },
    async () => {
      const { server, port } = await start(fixtureHosting());
      try {
        // A lying/absent content-length must not bypass the cap: the running
        // byte count crosses it mid-stream and the refusal fires there.
        const over = JSON.stringify({ pad: "y".repeat(MAX_BODY_BYTES + 64 * 1024) });
        const res = await chunkedPost(port, [over]);
        expect(res.status).toBe(413);
        expect(res.body).toContain("payload too large");
      } finally {
        server.close();
      }
    },
  );

  it(
    "refuses on content-length alone, before the body is sent",
    { timeout: 60_000 },
    async () => {
      const { server, port } = await start(fixtureHosting());
      try {
        // The client never sends a byte of the declared body; the 413 must
        // still arrive, because the pre-check refuses before reading.
        const status = await headerOnlyPost(port, "/api/build", MAX_BODY_BYTES * 10);
        expect(status).toBe(413);
      } finally {
        server.close();
      }
    },
  );

  it(
    "allows a body exactly at the cap and refuses one byte more",
    { timeout: 60_000 },
    async () => {
      const { server, port } = await start(fixtureHosting());
      try {
        const shell = JSON.stringify({ pad: "" });
        const padLen = MAX_BODY_BYTES - Buffer.byteLength(shell);
        const exact = JSON.stringify({ pad: "z".repeat(padLen) });
        expect(Buffer.byteLength(exact)).toBe(MAX_BODY_BYTES);
        // At the cap the body is read and parsed, so the route's own 400
        // ("missing source") answers — proof the cap let it through.
        expect((await chunkedPost(port, [exact])).status).toBe(400);
        const oneOver = JSON.stringify({ pad: "z".repeat(padLen + 1) });
        expect((await chunkedPost(port, [oneOver])).status).toBe(413);
      } finally {
        server.close();
      }
    },
  );
});

describe("v4.7 — numeric env options warn and fall back (finding #29)", () => {
  it("treats an empty or whitespace env var as unusable, not as zero", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const opts = { min: 1, name: "BREWDOCS_RATE_LIMIT" };
      // Number("") === 0 and Number("  ") === 0 — the pre-fix reads that made
      // `BREWDOCS_RATE_LIMIT=` mean "limit 0".
      expect(numOption(undefined, "", 10, opts)).toBe(10);
      expect(numOption(undefined, "   ", 10, opts)).toBe(10);
      expect(warn).toHaveBeenCalledTimes(2);
    } finally {
      warn.mockRestore();
    }
  });

  it("refuses negative and non-numeric env values", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      expect(numOption(undefined, "-5", 2, { min: 1, name: "BREWDOCS_MAX_BUILDS" })).toBe(2);
      expect(numOption(undefined, "0", 2, { min: 1, name: "BREWDOCS_MAX_BUILDS" })).toBe(2);
      expect(numOption(undefined, "abc", 2, { min: 1, name: "BREWDOCS_MAX_BUILDS" })).toBe(2);
      expect(numOption(undefined, "Infinity", 2, { min: 1, name: "BREWDOCS_MAX_BUILDS" })).toBe(2);
      expect(warn).toHaveBeenCalledTimes(4);
    } finally {
      warn.mockRestore();
    }
  });

  it("accepts a usable env value and stays silent when the var is unset", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      expect(numOption(undefined, "25", 10, { min: 1, name: "BREWDOCS_RATE_LIMIT" })).toBe(25);
      // maxQueue's floor is 0: "no queueing" is a real choice.
      expect(numOption(undefined, "0", 8, { min: 0, name: "BREWDOCS_MAX_QUEUE" })).toBe(0);
      expect(numOption(undefined, undefined, 10, { min: 1, name: "BREWDOCS_RATE_LIMIT" })).toBe(10);
      expect(warn).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });

  it("keeps the embedding channel: 0 is legal where it means 'no capacity'", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      // The queue-full 503 test depends on this: maxConcurrentBuilds: 0 via
      // createServer's options is a deliberate test input, not a typo.
      expect(numOption(0, undefined, 2, { min: 0, name: "BREWDOCS_MAX_BUILDS" })).toBe(0);
      expect(numOption(-1, undefined, 2, { min: 0, name: "BREWDOCS_MAX_BUILDS" })).toBe(2);
      expect(warn).toHaveBeenCalledTimes(1);
    } finally {
      warn.mockRestore();
    }
  });

  it(
    "BREWDOCS_RATE_LIMIT= falls back to the default instead of bricking the server",
    { timeout: 60_000 },
    async () => {
      const hosting = fs.mkdtempSync(path.join(os.tmpdir(), "brewdocs-env-"));
      const prev = process.env.BREWDOCS_RATE_LIMIT;
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      let server: http.Server | undefined;
      try {
        process.env.BREWDOCS_RATE_LIMIT = "";
        server = createServer(hosting);
        const port = await listenLocal(server);
        const post = () =>
          fetch(`http://127.0.0.1:${port}/api/build`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: "{}",
          });
        // Before the fix the second request answered 429 (limit 0); both must
        // now reach the route, which answers 400 for the missing source.
        expect((await post()).status).toBe(400);
        expect((await post()).status).toBe(400);
        expect(warn).toHaveBeenCalled();
      } finally {
        warn.mockRestore();
        if (prev === undefined) delete process.env.BREWDOCS_RATE_LIMIT;
        else process.env.BREWDOCS_RATE_LIMIT = prev;
        server?.close();
      }
    },
  );
});

describe("v4.7 — test servers bind loopback (finding #30)", () => {
  it("listenLocal binds 127.0.0.1, not every interface", async () => {
    const server = http.createServer((_req, res) => res.writeHead(200).end("ok"));
    try {
      await listenLocal(server);
      const addr = server.address();
      // A bare listen(0) answers { address: "::" } — every interface.
      expect(typeof addr === "object" && addr?.address).toBe("127.0.0.1");
    } finally {
      server.close();
    }
  });
});
