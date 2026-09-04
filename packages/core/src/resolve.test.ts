import { describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { resolveInput } from "./resolve.js";

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
});
