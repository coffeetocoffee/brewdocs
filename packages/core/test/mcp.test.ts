import { describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  runMcpServer,
  loadDocModel,
  validateAgainstSchema,
  checkFreshness,
  searchSymbols,
  symbolSignature,
  deprecatedReplacements,
  MCP_TOOLS,
  buildDocModel,
  type DocModelArtifact,
} from "@brewdocs/core";

const TINY = path.resolve(__dirname, "../../../examples/tiny");

/** A package with a documented + a deprecated symbol so tools have content. */
function fixtureSource(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "brewdocs-mcpfix-"));
  fs.writeFileSync(
    path.join(root, "package.json"),
    JSON.stringify({ name: "fixture", version: "1.0.0", main: "index.js" }),
    "utf8",
  );
  fs.writeFileSync(
    path.join(root, "index.js"),
    `/** Brew a cup.\n * @param {string} kind - what to brew\n * @returns {string} the cup\n */\nexport function brew(kind) { return "cup of " + kind; }\n\n/** Old brewer.\n * @deprecated use brew instead\n */\nexport function percolate() { return "old"; }\n`,
    "utf8",
  );
  fs.writeFileSync(path.join(root, "README.md"), "# fixture\n\nDocs.\n", "utf8");
  return root;
}

/** In-memory stdio: feed lines, capture replies. */
function fakeIo(lines: string[]) {
  const replies: string[] = [];
  let i = 0;
  return {
    replies,
    io: {
      read: () => Promise.resolve(i < lines.length ? lines[i++] : null),
      write: (line: string) => {
        replies.push(line);
      },
    },
  };
}

function parse(line: string): Record<string, unknown> {
  return JSON.parse(line) as Record<string, unknown>;
}

describe("v1.2 MCP server — validateAgainstSchema", () => {
  it("accepts an artifact emitted by the pipeline", () => {
    const out = fs.mkdtempSync(path.join(os.tmpdir(), "brewdocs-mcp-"));
    const file = buildDocModel({ root: fixtureSource() }, out);
    const { artifact } = loadDocModel(file);
    expect(artifact.schema).toBe("brewdocs/docmodel@1");
    expect(artifact.symbols.length).toBeGreaterThan(0);
    expect(validateAgainstSchema(artifact)).toEqual([]);
  });

  it("rejects a wrong schema const and missing required fields", () => {
    expect(
      validateAgainstSchema({ schema: "brewdocs/docmodel@2" }),
    ).toContainEqual(expect.stringMatching(/expected const/));
    expect(
      validateAgainstSchema({ schema: "brewdocs/docmodel@1" }),
    ).toContainEqual(expect.stringMatching(/missing required property "title"/));
  });
});

describe("v1.2 MCP server — freshness first", () => {
  const artifact = {
    schema: "brewdocs/docmodel@1",
    generatedAt: "2026-09-13T00:00:00Z",
    generator: { name: "brewdocs", version: "1.0.0" },
    version: "2.0.0",
    source: { gitSha: "abc1234def" },
    title: "tiny",
    symbols: [],
  } as unknown as DocModelArtifact;

  it("passes when versions match (or no expectation given)", () => {
    expect(checkFreshness(artifact).ok).toBe(true);
    expect(checkFreshness(artifact, "2.0.0").ok).toBe(true);
    expect(checkFreshness(artifact, "2.0.0").message).toContain("version=2.0.0");
    expect(checkFreshness(artifact, "2.0.0").message).toContain("gitSha=abc1234");
  });

  it("flags stale docs when the running code version differs", () => {
    const stale = checkFreshness(artifact, "3.0.0");
    expect(stale.ok).toBe(false);
    expect(stale.message).toMatch(/stale docs.*v2\.0\.0.*v3\.0\.0/);
  });
});

describe("v1.2 MCP server — tools over the artifact", () => {
  it("exposes exactly the three planned tools", () => {
    expect([...MCP_TOOLS]).toEqual([
      "search_symbols",
      "symbol_signature",
      "deprecated_replacements",
    ]);
  });

  it("answers initialize, tools/list, and tools/call", async () => {
    const out = fs.mkdtempSync(path.join(os.tmpdir(), "brewdocs-mcp2-"));
    const file = buildDocModel({ root: fixtureSource() }, out);
    const { artifact } = loadDocModel(file);
    expect(artifact.symbols.length).toBeGreaterThanOrEqual(2);
    const brew = artifact.symbols.find((s) => s.name === "brew")!;

    const { io, replies } = fakeIo([
      JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }),
      JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" }),
      JSON.stringify({
        jsonrpc: "2.0",
        id: 3,
        method: "tools/call",
        params: { name: "search_symbols", arguments: { query: brew.name } },
      }),
      JSON.stringify({
        jsonrpc: "2.0",
        id: 4,
        method: "tools/call",
        params: { name: "symbol_signature", arguments: { name: brew.name } },
      }),
      JSON.stringify({
        jsonrpc: "2.0",
        id: 5,
        method: "tools/call",
        params: { name: "deprecated_replacements", arguments: {} },
      }),
    ]);

    await runMcpServer(file, io);

    const init = parse(replies[0]).result as {
      protocolVersion: string;
      capabilities: { tools: unknown };
    };
    expect(init.protocolVersion).toBe("2024-11-05");
    expect(init.capabilities).toBeDefined();

    const tools = parse(replies[1]).result as {
      tools: Array<{ name: string; inputSchema: unknown }>;
    };
    expect(tools.tools.map((t) => t.name)).toEqual([...MCP_TOOLS]);
    for (const t of tools.tools) {
      expect(t.inputSchema).toBeDefined();
    }

    const search = parse(replies[2]).result as {
      content: [{ text: string }];
    };
    expect(search.content[0].text).toContain("freshness:");
    expect(search.content[0].text).toContain(brew.name);

    const sig = parse(replies[3]).result as { content: [{ text: string }] };
    expect(sig.content[0].text).toContain(brew.name);
    expect(sig.content[0].text).toContain("freshness:");

    const dep = parse(replies[4]).result as { content: [{ text: string }] };
    expect(dep.content[0].text).toMatch(/deprecated symbol|freshness/);
  });

  it("errors on unknown tools and parse errors, and reports staleness", async () => {
    const out = fs.mkdtempSync(path.join(os.tmpdir(), "brewdocs-mcp3-"));
    const file = buildDocModel({ root: fixtureSource() }, out);
    const { artifact } = loadDocModel(file);
    const name = artifact.symbols[0].name;

    const { io, replies } = fakeIo([
      "not json",
      JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name: "no_such_tool", arguments: {} },
      }),
      JSON.stringify({
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: {
          name: "symbol_signature",
          arguments: { name, expectedVersion: "999.0.0" },
        },
      }),
    ]);
    await runMcpServer(file, io);

    expect(parse(replies[0]).error).toMatchObject({ code: -32700 });
    expect(parse(replies[1]).error).toMatchObject({ code: -32602 });
    const stale = parse(replies[2]).result as { content: [{ text: string }] };
    expect(stale.content[0].text).toContain("stale docs");
  });

  it("search and replacement helpers work directly over the artifact", () => {
    const out = fs.mkdtempSync(path.join(os.tmpdir(), "brewdocs-mcp4-"));
    const { artifact } = loadDocModel(buildDocModel({ root: fixtureSource() }, out));
    expect(searchSymbols(artifact, "").length).toBeGreaterThan(0);
    expect(searchSymbols(artifact, "brew").map((s) => s.name)).toContain("brew");
    expect(symbolSignature(artifact, "brew")).toBeDefined();
    expect(symbolSignature(artifact, "nope")).toBeUndefined();
    const dep = deprecatedReplacements(artifact);
    expect(dep.length).toBeGreaterThan(0);
    expect(dep.find((d) => d.symbol === "percolate")?.replacements).toContain("brew");
  });
});
