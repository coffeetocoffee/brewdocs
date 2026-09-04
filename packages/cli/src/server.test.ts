import { describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { resolveSite } from "./server.js";

function tmp(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "brewdocs-host-"));
  fs.mkdirSync(path.join(dir, "demo"), { recursive: true });
  fs.writeFileSync(path.join(dir, "demo", "index.html"), "<h1>demo</h1>");
  return dir;
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
});
