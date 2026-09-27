import { describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { resolveInput } from "../src/resolve.js";

const EXAMPLES = path.resolve(__dirname, "../../../examples");
const libRoot = path.join(EXAMPLES, "lib");

describe("Phase 5 — resolve input", () => {
  it("resolves an existing local path", () => {
    const r = resolveInput(libRoot);
    expect(r.source.root).toBe(libRoot);
    expect(typeof r.cleanup).toBe("function");
    r.cleanup();
  });

  it("throws on unresolvable input without touching network", () => {
    expect(() => resolveInput("http://example.com/random-page")).toThrow();
  });

  // v3.5 security: fetching a package must never run its lifecycle scripts —
  // a postinstall is arbitrary code execution from a caller-supplied name,
  // reachable from the build API.
  it("passes --ignore-scripts when installing an npm package", () => {
    const src = fs.readFileSync(path.join(__dirname, "../src/resolve.ts"), "utf8");
    expect(src).toMatch(/runNpm\(\[[^\]]*"--ignore-scripts"/s);
  });
});
