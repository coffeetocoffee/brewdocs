import { describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  detectWorkspaces,
  crossPackageLinks,
  externalLinksFor,
  rollupCoverage,
  buildWorkspaces,
  buildModel,
} from "@brewdocs/core";

/** Scaffold a workspace monorepo: packages/a exports brew, packages/b exports steep. */
function scaffoldWorkspace(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "brewdocs-ws-"));
  fs.writeFileSync(
    path.join(root, "package.json"),
    JSON.stringify({
      name: "monorepo",
      private: true,
      workspaces: ["packages/*"],
    }),
    "utf8",
  );

  for (const [dir, name, symbol, documented] of [
    ["a", "@demo/alpha", "brew", true],
    ["b", "@demo/beta", "steep", false],
  ] as const) {
    const pkgDir = path.join(root, "packages", dir);
    fs.mkdirSync(pkgDir, { recursive: true });
    fs.writeFileSync(
      path.join(pkgDir, "package.json"),
      JSON.stringify({ name, version: "1.0.0", main: "index.js" }),
      "utf8",
    );
    fs.writeFileSync(
      path.join(pkgDir, "index.js"),
      documented
        ? `/** Brew a cup.\n * @param {string} kind - what to brew\n * @returns {string} the cup\n */\nexport function brew(kind) { return "cup of " + kind; }\n`
        : `/** Steep a cup from alpha's output.\n * @param {brew} cup - a brew() result\n */\nexport function steep(cup) { return cup; }\n`,
      "utf8",
    );
    fs.writeFileSync(path.join(pkgDir, "README.md"), `# ${name}\n\nDocs.\n`, "utf8");
  }
  return root;
}

describe("v1.2 workspace mode — detectWorkspaces", () => {
  it("detects npm workspaces from package.json globs", () => {
    const root = scaffoldWorkspace();
    const members = detectWorkspaces(root);
    expect(members.map((m) => m.name)).toEqual(["@demo/alpha", "@demo/beta"]);
    expect(members[0].dir).toBe("a");
    expect(members[0].root).toBe(path.join(root, "packages", "a"));
  });

  it("supports the yarn/pnpm object form and returns [] without workspaces", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "brewdocs-ws2-"));
    fs.writeFileSync(
      path.join(root, "package.json"),
      JSON.stringify({ workspaces: { packages: ["apps/*"] } }),
      "utf8",
    );
    const appDir = path.join(root, "apps", "one");
    fs.mkdirSync(appDir, { recursive: true });
    fs.writeFileSync(
      path.join(appDir, "package.json"),
      JSON.stringify({ name: "one" }),
      "utf8",
    );
    expect(detectWorkspaces(root).map((m) => m.name)).toEqual(["one"]);

    const solo = fs.mkdtempSync(path.join(os.tmpdir(), "brewdocs-solo-"));
    expect(detectWorkspaces(solo)).toEqual([]);
  });
});

describe("v1.2 workspace mode — cross-package links", () => {
  it("resolves other members' symbols to their pages, never self", () => {
    const root = scaffoldWorkspace();
    const members = detectWorkspaces(root);
    const models = new Map(
      members.map((m) => [m.name, buildModel({ root: m.root, name: m.name })]),
    );
    const cross = crossPackageLinks(members, models);
    expect(cross.has("brew")).toBe(true);
    expect(cross.has("steep")).toBe(true);

    const forA = externalLinksFor(members[0], cross);
    expect(forA.get("steep")).toBe("../b/index.html#symbol-steep");
    expect(forA.has("brew")).toBe(false); // own symbol stays an in-page anchor

    const forB = externalLinksFor(members[1], cross);
    expect(forB.get("brew")).toBe("../a/index.html#symbol-brew");
    expect(forB.has("steep")).toBe(false);
  });
});

describe("v1.2 workspace mode — rollup coverage", () => {
  it("scores per package and rolls up to a weighted workspace score", () => {
    const root = scaffoldWorkspace();
    const members = detectWorkspaces(root);
    const models = new Map(
      members.map((m) => [m.name, buildModel({ root: m.root, name: m.name })]),
    );
    const rollup = rollupCoverage(members, models);
    expect(rollup.packages).toHaveLength(2);
    // alpha is fully documented -> 100; beta has no docs -> low score.
    const alpha = rollup.packages.find((p) => p.name === "@demo/alpha");
    const beta = rollup.packages.find((p) => p.name === "@demo/beta");
    // alpha: documented + params + returns, but no @example -> 90.
    expect(alpha?.score).toBe(90);
    expect(beta!.score).toBeLessThan(90);
    expect(rollup.score).toBeGreaterThan(0);
    expect(rollup.score).toBeLessThan(100);
  });
});

describe("v1.2 workspace mode — buildWorkspaces", () => {
  it("builds one site per package plus a root index with the rollup chip", () => {
    const root = scaffoldWorkspace();
    const out = fs.mkdtempSync(path.join(os.tmpdir(), "brewdocs-wsout-"));
    const files = buildWorkspaces({ root }, out);

    expect(fs.existsSync(path.join(out, "a", "index.html"))).toBe(true);
    expect(fs.existsSync(path.join(out, "b", "index.html"))).toBe(true);
    // docmodel.json per member (default emission) powers cross-links.
    expect(fs.existsSync(path.join(out, "a", "docmodel.json"))).toBe(true);

    const bHtml = fs.readFileSync(path.join(out, "b", "index.html"), "utf8");
    // beta's page references alpha's symbol -> cross-package href.
    expect(bHtml).toContain('href="../a/index.html#symbol-brew"');

    const rootHtml = fs.readFileSync(path.join(out, "index.html"), "utf8");
    expect(rootHtml).toContain("coverage-chip");
    expect(rootHtml).toContain('href="./a/index.html"');
    expect(rootHtml).toContain("@demo/alpha");
    expect(files.length).toBeGreaterThanOrEqual(3);
  });

  it("throws a clear error when the source has no workspaces", () => {
    const solo = fs.mkdtempSync(path.join(os.tmpdir(), "brewdocs-solo2-"));
    expect(() => buildWorkspaces({ root: solo }, solo)).toThrow(/no workspaces found/);
  });
});
