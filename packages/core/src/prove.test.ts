import { describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { proveSource, proveSummary } from "./prove.js";

function makeProject(files: Record<string, string>): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "brewdocs-prove-"));
  for (const [name, content] of Object.entries(files)) {
    const abs = path.join(root, name);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content, "utf8");
  }
  return root;
}

const PKG = JSON.stringify({
  name: "lib",
  version: "1.0.0",
  main: "index.ts",
});

describe("v1.0.0 — prove", () => {
  it("passes a valid example that uses an exported symbol", () => {
    const root = makeProject({
      "package.json": PKG,
      "index.ts": `export function brew(src: string, n: number): string { return src + n; }`,
    });
    fs.writeFileSync(
      path.join(root, "index.ts"),
      `/**
 * @example
 * brew("a", 1);
 */
export function brew(src: string, n: number): string { return src + n; }`,
    );
    const results = proveSource({ root });
    const res = results.find((r) => r.symbol === "brew");
    expect(res).toBeTruthy();
    expect(res!.ok).toBe(true);
  });

  it("fails an example that calls a non-existent symbol", () => {
    const root = makeProject({
      "package.json": PKG,
      "index.ts": `export function brew(src: string): string { return src; }`,
    });
    // brew example references unknown `pour`
    fs.writeFileSync(
      path.join(root, "index.ts"),
      `/**
 * @example
 * pour("x");
 */
export function brew(src: string): string { return src; }`,
    );
    const results = proveSource({ root });
    const res = results.find((r) => r.symbol === "brew");
    expect(res).toBeTruthy();
    expect(res!.ok).toBe(false);
    expect(res!.error).toBeTruthy();
  });

  it("skips prose examples that are not code", () => {
    const root = makeProject({
      "package.json": PKG,
      "index.ts": `/**
 * @example
 * See the usage guide for details.
 */
export function brew(src: string): string { return src; }`,
    });
    const results = proveSource({ root });
    expect(results).toHaveLength(1);
    expect(results[0].skipped).toBe(true);
  });

  it("strips a code fence before typechecking", () => {
    const root = makeProject({
      "package.json": PKG,
      "index.ts": `export function brew(src: string, n: number): string { return src + n; }`,
    });
    fs.writeFileSync(
      path.join(root, "index.ts"),
      `/**
 * @example
 * \`\`\`ts
 * brew("a", 1);
 * \`\`\`
 */
export function brew(src: string, n: number): string { return src + n; }`,
    );
    const results = proveSource({ root });
    const res = results.find((r) => r.symbol === "brew");
    expect(res).toBeTruthy();
    expect(res!.ok).toBe(true);
  });

  it("summarizes proven vs passed", () => {
    const root = makeProject({
      "package.json": PKG,
      "index.ts": `export function brew(src: string): string { return src; }`,
    });
    fs.writeFileSync(
      path.join(root, "index.ts"),
      `/**
 * @example
 * brew("a");
 * @example
 * missingFn();
 */
export function brew(src: string): string { return src; }`,
    );
    const results = proveSource({ root });
    const s = proveSummary(results);
    expect(s.proven).toBe(2);
    expect(s.passed).toBe(1);
    expect(s.failed).toBe(1);
  });
});
