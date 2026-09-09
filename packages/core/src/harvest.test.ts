import { describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { harvestExamples } from "./harvest.js";
import { gateDecision } from "./ci.js";

function makeProject(files: Record<string, string>): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "brewdocs-harvest-"));
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

describe("v1.0.0 — harvest", () => {
  it("proposes a README code block that uses an undocumented-example symbol", () => {
    const root = makeProject({
      "package.json": PKG,
      "index.ts":
        "export function grind(kind: string, level: number): string { return kind + level; }",
      "README.md": `# lib\n\nUsage:\n\n\`\`\`ts\nimport { grind } from "lib";\ngrind("dark", 3);\n\`\`\`\n`,
    });
    const proposals = harvestExamples({ root });
    const p = proposals.find((x) => x.symbol === "grind");
    expect(p).toBeTruthy();
    expect(p!.origin).toBe("README.md:5");
    expect(p!.snippet).toContain('grind("dark", 3);');
  });

  it("proposes a call from a test file", () => {
    const root = makeProject({
      "package.json": PKG,
      "index.ts": "export function add(a: number, b: number): number { return a + b; }",
      "test/add.test.ts": `import { add } from "../index";\n\nit("adds", () => {\n  expect(add(1, 2)).toBe(3);\n});\n`,
    });
    const proposals = harvestExamples({ root });
    const p = proposals.find((x) => x.symbol === "add");
    expect(p).toBeTruthy();
    expect(p!.snippet).toContain("add(1, 2)");
    expect(p!.origin).toContain("test/add.test.ts:4");
  });

  it("returns nothing when every symbol already has an example", () => {
    const root = makeProject({
      "package.json": PKG,
      "index.ts": `/**\n * @example\n * add(1, 2);\n */\nexport function add(a: number, b: number): number { return a + b; }`,
      "README.md": "```ts\nadd(1, 2);\n```\n",
    });
    expect(harvestExamples({ root })).toHaveLength(0);
  });

  it("skips node_modules and non-test js files", () => {
    const root = makeProject({
      "package.json": PKG,
      "index.ts": "export function add(a: number, b: number): number { return a + b; }",
      "node_modules/left-pad/index.js": "add(9, 9);",
      "src/util.js": "add(7, 8);",
    });
    expect(harvestExamples({ root })).toHaveLength(0);
  });
});

describe("v1.0.0 — gate + prove wiring", () => {
  it("gate fails on unproven examples", () => {
    const d = gateDecision({
      breakingCount: 0,
      guideGenerated: false,
      acknowledged: false,
      unprovenExamples: 2,
    });
    expect(d.ok).toBe(false);
    expect(d.reason).toContain("2 doc example(s)");
  });

  it("gate passes clean examples even with breaking changes acknowledged", () => {
    const d = gateDecision({
      breakingCount: 1,
      guideGenerated: false,
      acknowledged: true,
      unprovenExamples: 0,
    });
    expect(d.ok).toBe(true);
  });

  it("acknowledgment overrides unproven examples", () => {
    const d = gateDecision({
      breakingCount: 0,
      guideGenerated: false,
      acknowledged: true,
      unprovenExamples: 1,
    });
    expect(d.ok).toBe(true);
  });
});
