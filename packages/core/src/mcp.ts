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

/** Name of one MCP tool (`search_symbols`, `symbol_signature`, `deprecated_replacements`). */
export type McpToolName = (typeof MCP_TOOLS)[number];

const PROTOCOL_VERSION = "2024-11-05";

export interface JsonRpcRequest {
  jsonrpc: "2.0";
  id?: number | string | null;
  method: string;
  params?: Record<string, unknown>;
}

export interface JsonRpcResponse {
  jsonrpc: "2.0";
  id?: number | string | null;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

/**
 * What one `tools/call` asked for and how much it found. This is the telemetry
 * unit: the HTTP transport records it so a site can answer "which symbols do
 * agents ask for and not find" — the question a static artifact cannot.
 */
export interface McpToolCall {
  tool: string;
  /** The caller's query (search term or symbol name); "" for whole-list tools. */
  query: string;
  /** Results returned. 0 is a miss. */
  hits: number;
}

function textContent(text: string): { content: [{ type: "text"; text: string }] } {
  return { content: [{ type: "text", text }] };
}

/**
 * Parse and structurally validate a `docmodel.json` from text. Throws when the
 * artifact is malformed — used by the file loader and by the federation fetch
 * path, which validates a remote artifact before trusting it.
 *
 * @param raw - the artifact's JSON text.
 * @returns the validated artifact.
 */
export function parseDocModel(raw: string): DocModelArtifact {
  const parsed = JSON.parse(raw) as Record<string, unknown>;
  const errors = validateAgainstSchema(parsed);
  if (errors.length > 0) {
    throw new Error(
      `docmodel.json failed schema validation (${DOCMODEL_SCHEMA}):\n  ${errors.join("\n  ")}`,
    );
  }
  return parsed as unknown as DocModelArtifact;
}

/**
 * Load and structurally validate a `docmodel.json` against the schema.
 *
 * @param file - path to the artifact on disk.
 * @returns the validated artifact plus any non-fatal warnings.
 */
export function loadDocModel(
  file: string,
): { artifact: DocModelArtifact; warnings: string[] } {
  const raw = fs.readFileSync(file, "utf8");
  const warnings: string[] = [];
  return { artifact: parseDocModel(raw), warnings };
}

/**
 * Structural validation of a parsed artifact against the published schema
 * (`packages/core/schemas/docmodel@1.schema.json`). Checks required fields,
 * const schema id, enums, and basic types — enough to reject anything a
 * consumer would misread, without shipping a full JSON Schema engine.
 *
 * @param value - parsed JSON value to validate.
 * @param schema - JSON Schema fragment to validate against (defaults to the published docmodel schema).
 * @param at - JSON-pointer-ish path prefix used in error messages.
 * @returns the list of validation errors (empty when valid).
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

/**
 * Freshness stamp: surfaced on every tool result before any content.
 *
 * @param artifact - loaded docmodel artifact whose stamp is described.
 * @returns a one-line `freshness: …` string with version, git sha and generatedAt.
 */
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
 *
 * @param artifact - loaded docmodel artifact to check.
 * @param expectedVersion - running code's version; a mismatch is reported as stale.
 * @returns whether the artifact is fresh, plus the freshness/stale message.
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

/**
 * `search_symbols`: fuzzy name search over the artifact's symbol set.
 *
 * @param artifact - loaded docmodel artifact to search.
 * @param query - substring matched against symbol names and descriptions (empty returns all).
 * @returns the matching symbols.
 */
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

/**
 * `symbol_signature`: one symbol's full signature + docs block.
 *
 * @param artifact - loaded docmodel artifact to look in.
 * @param name - exact exported symbol name to find.
 * @returns the matching symbol, or undefined when it is not exported.
 */
export function symbolSignature(artifact: DocModelArtifact, name: string) {
  return artifact.symbols.find((s) => s.name === name);
}

/**
 * `deprecated_replacements`: every deprecated symbol and its successors.
 *
 * @param artifact - loaded docmodel artifact to scan.
 * @returns records of deprecated symbols with their notes and replacements.
 */
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
): { content: [{ type: "text"; text: string }]; hits: number } | { error: string } {
  if (!MCP_TOOLS.includes(name as McpToolName)) {
    return { error: `unknown tool: ${name}` };
  }

  const expected = args.expectedVersion as string | undefined;

  if (name === "search_symbols") {
    const q = typeof args.query === "string" ? args.query : "";
    const results = searchSymbols(artifact, q);
    return {
      hits: results.length,
      ...textContent(
        `${checkFreshness(artifact, expected).message}\n${results.length} symbol(s) match "${q}":\n` +
          results
            .map((s) => `- ${s.name} (${s.kind})${s.deprecated ? " [deprecated]" : ""}`)
            .join("\n"),
      ),
    };
  }

  if (name === "symbol_signature") {
    const sym = typeof args.name === "string" ? symbolSignature(artifact, args.name) : undefined;
    if (!sym) return { error: `symbol not found: ${String(args.name)}` };
    const params = sym.params
      .map((p) => `  ${p.name}${p.optional ? "?" : ""}${p.type ? `: ${p.type}` : ""}${p.description ? ` — ${p.description}` : ""}`)
      .join("\n");
    const replacements = sym.replacements ?? [];
    return {
      hits: 1,
      ...textContent(
        `${checkFreshness(artifact, expected).message}\n${sym.name} (${sym.kind})\n${
          sym.signature ?? ""
        }\n${sym.description ?? ""}${params ? `\nparams:\n${params}` : ""}${
          sym.returns?.type ? `\nreturns: ${sym.returns.type}` : ""
        }${sym.deprecated ? `\ndeprecated: ${typeof sym.deprecated === "string" ? sym.deprecated : "yes"}${replacements.length ? ` — use ${replacements.join(", ")} instead` : ""}` : ""}`,
      ),
    };
  }

  // deprecated_replacements
  const list = deprecatedReplacements(artifact);
  return {
    hits: list.length,
    ...textContent(
      `${checkFreshness(artifact, expected).message}\n${list.length} deprecated symbol(s):\n` +
        list
          .map(
            (d) =>
              `- ${d.symbol}${d.replacements.length ? ` -> use ${d.replacements.join(", ")} instead` : ""}${d.note ? ` (${d.note})` : ""}`,
          )
          .join("\n"),
    ),
  };
}

/** The caller's query for telemetry: search term, or symbol name, else "". */
function toolQuery(name: string, args: Record<string, unknown>): string {
  if (name === "search_symbols") return typeof args.query === "string" ? args.query : "";
  if (name === "symbol_signature") return typeof args.name === "string" ? args.name : "";
  return "";
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

/** Notified for every successful `tools/call`, with its hit count. */
export type McpToolCallListener = (call: McpToolCall) => void;

/**
 * Answer one JSON-RPC message against a loaded artifact. Returns the response
 * line, or `null` when the message is a notification (no reply). Both the stdio
 * loop and the HTTP transport go through here, so the two speak exactly one
 * protocol and a change cannot land in only one of them.
 *
 * @param artifact - loaded docmodel artifact the tools run against.
 * @param line - one JSON-RPC request message.
 * @param onToolCall - optional listener notified for every successful tool call.
 * @returns the response line, or null when the message is a notification.
 */
export function handleMcpMessage(
  artifact: DocModelArtifact,
  line: string,
  onToolCall?: McpToolCallListener,
): string | null {
  let request: JsonRpcRequest;
  try {
    request = JSON.parse(line) as JsonRpcRequest;
  } catch {
    return JSON.stringify({
      jsonrpc: "2.0",
      id: null,
      error: { code: -32700, message: "parse error" },
    });
  }

  const respond = (payload: JsonRpcResponse) => JSON.stringify(payload);

  if (request.method === "initialize") {
    return respond({
      jsonrpc: "2.0",
      id: request.id,
      result: {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: { tools: {} },
        serverInfo: { name: "brewdocs", version: artifact.generator.version },
      },
    });
  }

  if (request.method === "tools/list") {
    return respond({ jsonrpc: "2.0", id: request.id, result: toolDescriptors() });
  }

  if (request.method === "tools/call") {
    const params = (request.params ?? {}) as {
      name?: string;
      arguments?: Record<string, unknown>;
    };
    const toolName = params.name ?? "";
    const toolArgs = params.arguments ?? {};
    const result = runTool(artifact, toolName, toolArgs);
    if ("error" in result) {
      // A miss (symbol not found) is the signal this whole feature exists to
      // capture, so record it before answering with the error.
      if (result.error.startsWith("symbol not found")) {
        onToolCall?.({ tool: toolName, query: toolQuery(toolName, toolArgs), hits: 0 });
      }
      return respond({
        jsonrpc: "2.0",
        id: request.id,
        error: { code: -32602, message: result.error },
      });
    }
    onToolCall?.({ tool: toolName, query: toolQuery(toolName, toolArgs), hits: result.hits });
    return respond({ jsonrpc: "2.0", id: request.id, result: { content: result.content } });
  }

  if (request.method.startsWith("notifications/")) return null; // no reply
  return respond({
    jsonrpc: "2.0",
    id: request.id,
    error: { code: -32601, message: `method not found: ${request.method}` },
  });
}

/**
 * Run one JSON-RPC request against a `docmodel.json` on disk — the entry point
 * the HTTP transport uses. Loads the artifact per call so a re-deploy is picked
 * up immediately (the same freshness the static file server gives). Returns a
 * JSON-RPC error object when the artifact is unreadable, never throws.
 *
 * @param docmodelFile - path to the `docmodel.json` to load per call.
 * @param raw - one JSON-RPC request message.
 * @param onToolCall - optional listener notified for every successful tool call.
 * @returns the HTTP status and response body for the request.
 */
export function handleMcpRequest(
  docmodelFile: string,
  raw: string,
  onToolCall?: McpToolCallListener,
): { status: number; body: string } {
  const file = path.resolve(docmodelFile);
  let artifact: DocModelArtifact;
  try {
    ({ artifact } = loadDocModel(file));
  } catch (err) {
    return {
      status: 200,
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: null,
        error: {
          code: -32002,
          message: `could not load ${file}: ${err instanceof Error ? err.message : err}`,
        },
      }),
    };
  }
  const reply = handleMcpMessage(artifact, raw, onToolCall);
  return { status: 200, body: reply ?? "" };
}

/**
 * Run the stdio MCP server loop. Reads JSON-RPC messages (one per line) and
 * answers `initialize`, `tools/list`, and `tools/call`. Lines are also
 * accepted newline-delimited (NDJSON) — one request object per line.
 *
 * @param docmodelFile - path to the `docmodel.json` the server answers from.
 * @param io - optional read/write transport override (defaults to stdio).
 * @returns a promise that settles when stdin closes (EOF or TTY).
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
    const reply = handleMcpMessage(artifact, line);
    if (reply !== null) transport.write(reply);
  }
}
