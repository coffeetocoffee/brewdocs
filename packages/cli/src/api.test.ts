import { afterAll, beforeAll, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createServer } from "./server.js";

const PORT = 4199;
const BASE = `http://localhost:${PORT}`;
const EXAMPLES = path.resolve(__dirname, "../../../examples");
const libRoot = path.join(EXAMPLES, "lib");

let server: ReturnType<typeof createServer>;
let hostingDir: string;

beforeAll(async () => {
  hostingDir = fs.mkdtempSync(path.join(os.tmpdir(), "brewdocs-api-"));
  server = createServer(hostingDir);
  await new Promise<void>((resolve) => server.listen(PORT, () => resolve()));
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  fs.rmSync(hostingDir, { recursive: true, force: true });
});

describe("Phase 5 — API endpoints", () => {
  // Brewing runs a full TS extraction per request; under a loaded suite that
  // can exceed vitest's 5s default, so give these endpoints headroom.
  it(
    "POST /api/build brews a site from a local path and returns a URL",
    { timeout: 30_000 },
    async () => {
      const res = await fetch(`${BASE}/api/build`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ source: libRoot }),
      });
      expect(res.status).toBe(200);
      const json = (await res.json()) as { url: string; subdomain: string };
      expect(json.subdomain).toBe("lib");
      expect(json.url).toBe("https://lib.brewdocs.dev");
    },
  );

  it("serves the brewed site at /s/<subdomain>/", async () => {
    const res = await fetch(`${BASE}/s/lib/`);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("BrewDocs");
  });

  it("GET /api/sites lists deployed sites", async () => {
    const res = await fetch(`${BASE}/api/sites`);
    const sites = (await res.json()) as Array<{ subdomain: string }>;
    expect(sites.some((s) => s.subdomain === "lib")).toBe(true);
  });

  it(
    "POST /api/export returns a downloadable HTML file",
    { timeout: 30_000 },
    async () => {
      const res = await fetch(`${BASE}/api/export`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ source: libRoot }),
      });
      expect(res.status).toBe(200);
      expect(res.headers.get("content-disposition")).toContain(".html");
      const html = await res.text();
      expect(html).toContain("BrewDocs");
    },
  );

  it("serves the web drop-in at /", async () => {
    const res = await fetch(`${BASE}/`);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("BrewDocs");
    expect(html).toContain('id="url"');
  });
});
