import { describe, expect, it } from "vitest";
import * as http from "node:http";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createSecureServer, createServer, resolveSite } from "./server.js";
import { addDomain, deploySite, verifyDomain } from "@brewdocs/core";

/** Raw HTTP GET with an explicit Host header (fetch forbids overriding Host). */
function getWithHost(
  port: number,
  hostHeader: string,
  route = "/",
): Promise<{ status: number; text: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: "127.0.0.1", port, path: route, headers: { host: hostHeader } },
      (res) => {
        let data = "";
        res.on("data", (c) => (data += c));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, text: data }));
      },
    );
    req.on("error", reject);
    req.end();
  });
}

const EXAMPLES = path.resolve(__dirname, "../../../examples");
const tinyRoot = path.join(EXAMPLES, "tiny");

function tmp(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "brewdocs-cdom-"));
}

describe("v2.5 custom domains — host routing", () => {
  it("routes a verified custom domain to its site at the domain root", async () => {
    const hosting = tmp();
    await deploySite({ root: tinyRoot, name: "lib" }, hosting, "lib");
    const rec = addDomain(hosting, "docs.acme.test", "lib")!;
    // Unverified mappings are ignored.
    expect(resolveSite("/", "docs.acme.test", hosting)).toBeNull();
    const ok = await verifyDomain(hosting, "docs.acme.test", async () => rec.token);
    expect(ok).toBe(true);

    const r = resolveSite("/", "docs.acme.test", hosting);
    expect(r?.subdomain).toBe("lib");
    expect(r?.filePath.endsWith(path.join("lib", "index.html"))).toBe(true);
    const deep = resolveSite("/symbols/x.html", "docs.acme.test:4000", hosting);
    expect(deep).toBeNull(); // no such file, still guarded
  });

  it(
    "serves the site over a custom Host header end to end",
    { timeout: 60_000, retry: 2 },
    async () => {
      const hosting = tmp();
      await deploySite({ root: tinyRoot, name: "lib" }, hosting, "lib");
      const rec = addDomain(hosting, "docs.acme.test", "lib")!;
      await verifyDomain(hosting, "docs.acme.test", async () => rec.token);

      const server = createServer(hosting);
      await new Promise<void>((r) => server.listen(0, r));
      const addr = server.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      try {
        const mine = await getWithHost(port, "docs.acme.test");
        expect(mine.status).toBe(200);
        expect(mine.text).toContain("BrewDocs");
        // The site index, not the web drop-in (which carries id="url").
        expect(mine.text).not.toContain('id="url"');

        const other = await getWithHost(port, "unclaimed.test");
        expect(other.text).toContain('id="url"');
      } finally {
        server.close();
      }
    },
  );

  it("fails fast on invalid TLS credentials (no silent plaintext fallback)", () => {
    const hosting = tmp();
    expect(() =>
      createSecureServer(hosting, undefined, undefined, undefined, {
        cert: "not-a-real-cert",
        key: "not-a-real-key",
      }),
    ).toThrow();
  });
});
