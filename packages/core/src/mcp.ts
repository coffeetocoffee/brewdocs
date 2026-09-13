import * as fs from "node:fs";
import * as path from "node:path";
import {
  DOCMODEL_SCHEMA,
  type DocModelArtifact,
} from "./docmodel.js";
import { DOCMODEL_SCHEMA_OBJECT } from "./schema.js";

/**
 * Minimal MCP (Model Context Protocol) server over stdio (v1.2): a thin
 * consumer of a validated `docmodel.json` — no new extraction, just tools
 * over the artifact for agent-driven workflows.
 *
 * Implements the JSON-RPC 2.0 message flow MCP clients speak:
 *   - `initialize` -> capabilities + protocol version
 *   - `tools/list` -> tool descriptors
 *   - `tools/call` -> run a tool against the artifact
 *
 * Freshness first: every `tools/call` result carries the freshness stamp
 * (`version`, `gitSha`, `generatedAt`) so agents never trust stale docs.
 */

/** Tool names the server exposes. */
export const MCP_TOOLS = [
  "search_symbols",
  "symbol_signature",
  "deprecated_replacements",
] as const;

export type McpToolName = (typeof MCP_TOOLS)[number];

const PROTOCOL_VERSION = "2024-11-05";

interface JsonRpcRequest {
  jsonrpc: "2.0";
  id?: number | string | null;
  method: string;
  params?: Record<string, unknown>;
}

interface JsonRpcResponse {
  jsonrpc: "2.0";
  id?: number | string | null;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

function textContent(text: string): { content: [{ type: "text"; text: string }] } {
  return { content: [{ type: "text", text }] };
}

/** Load and structurally validate a `docmodel.json` against the schema. */
export function loadDocModel(
  file: string,
): { artifact: DocModelArtifact; warnings: string[] } {
  const raw = JSON.parse(fs.readFileSync(file, "utf8")) as Record<string, unknown>;
  const warnings: string[] = [];
  const errors = validateAgainstSchema(raw);
  if (errors.length > 0) {
    throw new Error(
      `docmodel.json failed schema validation (${DOCMODEL_SCHEMA}):\n  ${errors.join("\n  ")}`,
    );
  }
  return { artifact: raw as unknown as DocModelArtifact, warnings };
}

/**
 * Structural validation of a parsed artifact against the published schema
 * (`packages/core/schemas/docmodel@1.schema.json`). Checks required fields,
 * const schema id, enums, and basic types — enough to reject anything a
 * consumer would misread, without shipping a full JSON Schema engine.
 */
export function validateAgainstSchema(
  value: unknown,
  schema: object | undefined = DOCMODEL_SCHEMA_OBJECT as unknown as Record<string, unknown>,
  at = "",
): string[] {
  const errors: string[] = [];
  if (!schema) return errors;
  const s = schema as {
    type?: string;
    const?: unknown;
    required?: string[];
    properties?: Record<string, unknown>;
    items?: unknown;
    enum?: unknown[];
    additionalProperties?: boolean | { properties?: Record<string, unknown> };
  };
  const here = at || "$";

  if (s.const !== undefined) {
    if (value !== s.const) errors.push(`${here}: expected const ${JSON.stringify(s.const)}`);
    return errors;
  }
  if (s.enum !== undefined && !s.enum.includes(value as never)) {
    errors.push(`${here}: ${JSON.stringify(value)} not in enum [${s.enum.join(", ")}]`);
    return errors;
  }
  if (s.type === "object" || s.properties) {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      errors.push(`${here}: expected object`);
      return errors;
    }
    const obj = value as Record<string, unknown>;
    for (const key of s.required ?? []) {
      if (!(key in obj)) errors.push(`${here}: missing required property "${key}"`);
    }
    for (const [key, sub] of Object.entries(
      s.properties ?? {},
    ) as Array<[string, object]>) {
      if (key in obj) {
        errors.push(...validateAgainstSchema(obj[key], sub, `${here}.${key}`));
      }
    }
    if (s.additionalProperties === false) {
      const known = new Set(Object.keys(s.properties ?? {}));
      for (const key of Object.keys(obj)) {
        if (!known.has(key)) errors.push(`${here}: unexpected property "${key}"`);
      }
    }
    return errors;
  }
  if (s.type === "array" || s.items) {
    if (!Array.isArray(value)) {
      errors.push(`${here}: expected array`);
      return errors;
    }
    const itemSchema = s.items as Record<string, unknown>;
    value.forEach((v, i) => {
      errors.push(...validateAgainstSchema(v, itemSchema, `${here}[${i}]`));
    });
    return errors;
  }
  if (s.type === "string" && typeof value !== "string") {
    errors.push(`${here}: expected string`);
  }
  if (s.type === "number" && (typeof value !== "number" || Number.isNaN(value))) {
    errors.push(`${here}: expected number`);
  }
  if (s.type === "integer" && (!Number.isInteger(value))) {
    errors.push(`${here}: expected integer`);
  }
  if (s.type === "boolean" && typeof value !== "boolean") {
    errors.push(`${here}: expected boolean`);
  }
  return errors;
}

/** Freshness stamp: surfaced on every tool result before any content. */
export function freshnessStamp(artifact: DocModelArtifact): string {
  const bits: string[] = [];
  if (artifact.version) bits.push(`version=${artifact.version}`);
  if (artifact.source?.gitSha) bits.push(`gitSha=${artifact.source.gitSha.slice(0, 7)}`);
  bits.push(`generatedAt=${artifact.generatedAt}`);
  return `freshness: ${bits.join(" ")}`;
}

/**
 * Freshness check: reject the artifact when `expectedVersion` (the running
 * code's version) differs from the artifact's `version` — "docs from v2,
 * code is at v3" — so agents never trust stale docs.
 */
export function checkFreshness(
  artifact: DocModelArtifact,
  expectedVersion?: string,
): { ok: boolean; message: string } {
  if (expectedVersion && artifact.version && expectedVersion !== artifact.version) {
    return {
      ok: false,
      message: `stale docs: artifact describes v${artifact.version} but running code is v${expectedVersion}`,
    };
  }
  return { ok: true, message: freshnessStamp(artifact) };
}

/** `search_symbols`: fuzzy name search over the artifact's symbol set. */
export function searchSymbols(
  artifact: DocModelArtifact,
  query: string,
): DocModelArtifact["symbols"] {
  const q = query.toLowerCase().trim();
  if (!q) return artifact.symbols;
  return artifact.symbols.filter((s) => {
    if (s.name.toLowerCase().includes(q)) return true;
    if (s.description && s.description.toLowerCase().includes(q)) return true;
    return false;
  });
}

/** `symbol_signature`: one symbol's full signature + docs block. */
export function symbolSignature(artifact: DocModelArtifact, name: string) {
  return artifact.symbols.find((s) => s.name === name);
}

/** `deprecated_replacements`: every deprecated symbol and its successors. */
export function deprecatedReplacements(artifact: DocModelArtifact) {
  return artifact.symbols
    .filter((s) => s.deprecated)
    .map((s) => ({
      symbol: s.name,
      note: typeof s.deprecated === "string" ? s.deprecated : undefined,
      replacements: s.replacements ?? [],
    }));
}

/** Render one tool call's result text (freshness prefix + payload). */
function runTool(
  artifact: DocModelArtifact,
  name: string,
  args: Record<string, unknown>,
): { content: [{ type: "text"; text: string }] } | { error: string } {
  if (!MCP_TOOLS.includes(name as McpToolName)) {
    return { error: `unknown tool: ${name}` };
  }

  const expected = args.expectedVersion as string | undefined;

  if (name === "search_symbols") {
    const q = typeof args.query === "string" ? args.query : "";
    const results = searchSymbols(artifact, q);
    return textContent(
      `${checkFreshness(artifact, expected).message}\n${results.length} symbol(s) match "${q}":\n` +
        results
          .map((s) => `- ${s.name} (${s.kind})${s.deprecated ? " [deprecated]" : ""}`)
          .join("\n"),
    );
  }

  if (name === "symbol_signature") {
    const sym = typeof args.name === "string" ? symbolSignature(artifact, args.name) : undefined;
    if (!sym) return { error: `symbol not found: ${String(args.name)}` };
    const params = sym.params
      .map((p) => `  ${p.name}${p.optional ? "?" : ""}${p.type ? `: ${p.type}` : ""}${p.description ? ` — ${p.description}` : ""}`)
      .join("\n");
    const replacements = sym.replacements ?? [];
    return textContent(
      `${checkFreshness(artifact, expected).message}\n${sym.name} (${sym.kind})\n${
        sym.signature ?? ""
      }\n${sym.description ?? ""}${params ? `\nparams:\n${params}` : ""}${
        sym.returns?.type ? `\nreturns: ${sym.returns.type}` : ""
      }${sym.deprecated ? `\ndeprecated: ${typeof sym.deprecated === "string" ? sym.deprecated : "yes"}${replacements.length ? ` — use ${replacements.join(", ")} instead` : ""}` : ""}`,
    );
  }

  // deprecated_replacements
  const list = deprecatedReplacements(artifact);
  return textContent(
    `${checkFreshness(artifact, expected).message}\n${list.length} deprecated symbol(s):\n` +
      list
        .map(
          (d) =>
            `- ${d.symbol}${d.replacements.length ? ` -> use ${d.replacements.join(", ")} instead` : ""}${d.note ? ` (${d.note})` : ""}`,
        )
        .join("\n"),
  );
}

function toolDescriptors() {
  return {
    tools: MCP_TOOLS.map((name) => {
      if (name === "search_symbols") {
        return {
          name,
          description: "Search exported symbols by name or description substring.",
          inputSchema: {
            type: "object",
            properties: {
              query: { type: "string", description: "Substring to match" },
              expectedVersion: {
                type: "string",
                description: "Running code's version; mismatches are reported as stale docs.",
              },
            },
          },
        };
      }
      if (name === "symbol_signature") {
        return {
          name,
          description: "Full signature + docs of one exported symbol.",
          inputSchema: {
            type: "object",
            properties: {
              name: { type: "string", description: "Exported symbol name" },
              expectedVersion: { type: "string" },
            },
            required: ["name"],
          },
        };
      }
      return {
        name,
        description: "List deprecated symbols and their replacements.",
        inputSchema: {
          type: "object",
          properties: {
            expectedVersion: { type: "string" },
          },
        },
      };
    }),
  };
}

/**
 * Line-oriented stdin reader: resolves one line at a time, `null` at EOF.
 */
function stdioReader(): { read: () => Promise<string | null> } {
  let buffer = "";
  let done = false;
  const queue: string[] = [];
  const waiters: Array<(line: string | null) => void> = [];

  const pump = (): void => {
    while (waiters.length > 0 && queue.length > 0) {
      waiters.shift()!(queue.shift() ?? null);
    }
    if (waiters.length > 0 && done) {
      while (waiters.length > 0) waiters.shift()!(null);
    }
  };

  if (process.stdin.isTTY) {
    done = true;
  } else {
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk: string) => {
      buffer += chunk;
      let idx: number;
      while ((idx = buffer.indexOf("\n")) >= 0) {
        queue.push(buffer.slice(0, idx).replace(/\r$/, ""));
        buffer = buffer.slice(idx + 1);
      }
      pump();
    });
    process.stdin.on("end", () => {
      if (buffer) queue.push(buffer);
      done = true;
      pump();
    });
  }

  return {
    read: () =>
      new Promise((resolve) => {
        if (queue.length > 0) {
          resolve(queue.shift() ?? null);
          return;
        }
        if (done) {
          resolve(null);
          return;
        }
        waiters.push(resolve);
      }),
  };
}

/**
 * Run the stdio MCP server loop. Reads JSON-RPC messages (one per line) and
 * answers `initialize`, `tools/list`, and `tools/call`. Lines are also
 * accepted newline-delimited (NDJSON) — one request object per line.
 */
export async function runMcpServer(
  docmodelFile: string,
  io?: { read: () => Promise<string | null>; write: (line: string) => void },
): Promise<void> {
  const transport = io ?? {
    ...stdioReader(),
    write: (line: string) => {
      process.stdout.write(line + "\n");
    },
  };
  const file = path.resolve(docmodelFile);
  let artifact: DocModelArtifact;
  try {
    ({ artifact } = loadDocModel(file));
  } catch (err) {
    transport.write(
      JSON.stringify({
        jsonrpc: "2.0",
        id: null,
        error: {
          code: -32002,
          message: `could not load ${file}: ${err instanceof Error ? err.message : err}`,
        },
      }),
    );
    return;
  }

  for (;;) {
    const line = await transport.read();
    if (!line) return;
    if (!line.trim()) continue;

    let request: JsonRpcRequest;
    try {
      request = JSON.parse(line) as JsonRpcRequest;
    } catch {
      transport.write(
        JSON.stringify({
          jsonrpc: "2.0",
          id: null,
          error: { code: -32700, message: "parse error" },
        }),
      );
      continue;
    }

    const respond = (payload: JsonRpcResponse) => transport.write(JSON.stringify(payload));

    if (request.method === "initialize") {
      respond({
        jsonrpc: "2.0",
        id: request.id,
        result: {
          protocolVersion: PROTOCOL_VERSION,
          capabilities: { tools: {} },
          serverInfo: { name: "brewdocs", version: artifact.generator.version },
        },
      });
      continue;
    }

    if (request.method === "tools/list") {
      respond({ jsonrpc: "2.0", id: request.id, result: toolDescriptors() });
      continue;
    }

    if (request.method === "tools/call") {
      const params = (request.params ?? {}) as {
        name?: string;
        arguments?: Record<string, unknown>;
      };
      const result = runTool(artifact, params.name ?? "", params.arguments ?? {});
      if ("error" in result) {
        respond({
          jsonrpc: "2.0",
          id: request.id,
          error: { code: -32602, message: result.error },
        });
      } else {
        respond({ jsonrpc: "2.0", id: request.id, result });
      }
      continue;
    }

    if (request.method.startsWith("notifications/")) continue; // no reply
    respond({
      jsonrpc: "2.0",
      id: request.id,
      error: { code: -32601, message: `method not found: ${request.method}` },
    });
  }
}
