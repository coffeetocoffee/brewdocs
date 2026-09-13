import * as fs from "node:fs";
import * as path from "node:path";
import type { SymbolDoc } from "../types.js";
import type { LanguageAdapter } from "../plugins.js";

/**
 * v2.5 OpenAPI + GraphQL extractors. Proves the adapter architecture on
 * non-code API descriptions: an `openapi.json|yaml` (or `swagger.json`) spec
 * becomes documented operations; a `schema.graphql` becomes types and root
 * query/mutation fields. Pure static parsing — no network, no toolchain — so
 * it degrades gracefully (warn + skip) like the Go adapter.
 */

/* ------------------------------------------------------------------ *
 * Minimal YAML (block + flow) reader for OpenAPI documents.           *
 * Avoids a YAML dependency; on malformed input it returns {} rather   *
 * than throwing, so a bad spec never breaks a build.                  *
 * ------------------------------------------------------------------ */

type YamlValue = unknown;

function parseYaml(text: string): YamlValue {
  const lines = text.split(/\r?\n/);
  let pos = 0;
  const indentOf = (l: string): number => (l.match(/^ */) as RegExpMatchArray)[0].length;

  function skip(): void {
    while (pos < lines.length) {
      const l = lines[pos];
      if (l.trim() === "" || l.trimStart().startsWith("#")) pos++;
      else break;
    }
  }

  function findColon(s: string): number {
    let q: string | null = null;
    for (let k = 0; k < s.length; k++) {
      const ch = s[k];
      if (q) {
        if (ch === q) q = null;
        continue;
      }
      if (ch === '"' || ch === "'") {
        q = ch;
        continue;
      }
      if (ch === ":") {
        if (k + 1 >= s.length || s[k + 1] === " " || s[k + 1] === "\t") return k;
      }
    }
    return -1;
  }

  function splitTop(s: string, sep: string): string[] {
    const out: string[] = [];
    let depth = 0;
    let q: string | null = null;
    let cur = "";
    for (let k = 0; k < s.length; k++) {
      const ch = s[k];
      if (q) {
        cur += ch;
        if (ch === q) q = null;
        continue;
      }
      if (ch === '"' || ch === "'") {
        q = ch;
        cur += ch;
        continue;
      }
      if (ch === "[" || ch === "{") depth++;
      if (ch === "]" || ch === "}") depth--;
      if (ch === sep && depth === 0) {
        out.push(cur);
        cur = "";
      } else cur += ch;
    }
    if (cur.trim() !== "") out.push(cur);
    return out;
  }

  function parseInlineAny(s: string): YamlValue {
    s = s.trim();
    if (s.startsWith("[")) return parseFlowSeq(s);
    if (s.startsWith("{")) return parseFlowMap(s);
    return parseScalar(s);
  }

  function parseScalar(v: string): YamlValue {
    v = v.trim();
    if (v === "" || v === "null" || v === "~") return null;
    if (v === "true") return true;
    if (v === "false") return false;
    if (/^-?\d+$/.test(v)) return Number(v);
    if (/^-?\d*\.\d+$/.test(v)) return Number(v);
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
      return v.slice(1, -1);
    }
    return v;
  }

  function parseFlowSeq(v: string): unknown[] {
    const inner = v.slice(1, -1).trim();
    if (!inner) return [];
    return splitTop(inner, ",").map((p) => parseInlineAny(p));
  }

  function parseFlowMap(v: string): Record<string, unknown> {
    const inner = v.slice(1, -1).trim();
    const out: Record<string, unknown> = {};
    if (!inner) return out;
    for (const part of splitTop(inner, ",")) {
      const idx = findColon(part);
      if (idx < 0) continue;
      const k = part.slice(0, idx).trim().replace(/^["']|["']$/g, "");
      out[k] = parseInlineAny(part.slice(idx + 1));
    }
    return out;
  }

  function readBlockScalar(kind: string): string {
    const content: string[] = [];
    let base = -1;
    while (pos < lines.length) {
      const l = lines[pos];
      if (l.trim() === "") {
        content.push("");
        pos++;
        continue;
      }
      const ind = indentOf(l);
      if (base < 0) base = ind;
      if (ind < base) break;
      content.push(l.slice(base));
      pos++;
    }
    while (content.length && content[content.length - 1] === "") content.pop();
    if (kind === ">") return content.join(" ") + "\n";
    return content.join("\n") + "\n";
  }

  function parseNode(indent: number): YamlValue {
    skip();
    if (pos >= lines.length) return null;
    const line = lines[pos];
    if (indentOf(line) < indent) return null;
    return line.trimStart().startsWith("- ") ? parseSeq(indentOf(line)) : parseMap(indentOf(line));
  }

  function parseMap(indent: number): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    while (pos < lines.length) {
      skip();
      if (pos >= lines.length) break;
      const line = lines[pos];
      const cur = indentOf(line);
      if (cur < indent) break;
      if (cur > indent) break;
      const trimmed = line.trimStart();
      if (trimmed.startsWith("- ")) break;
      const colon = findColon(trimmed);
      if (colon < 0) {
        pos++;
        continue;
      }
      const key = trimmed.slice(0, colon).trim().replace(/^["']|["']$/g, "");
      const rest = trimmed.slice(colon + 1).trim();
      pos++;
      if (rest === "|" || rest === ">" || rest.endsWith("|") || rest.endsWith(">")) {
        out[key] = readBlockScalar(rest.trim()[0]);
      } else if (rest === "") {
        out[key] = parseNode(indent + 1) ?? null;
      } else if (rest.startsWith("[") || rest.startsWith("{")) {
        out[key] = parseInlineAny(rest);
      } else {
        out[key] = parseScalar(rest);
      }
    }
    return out;
  }

  function parseSeq(indent: number): unknown[] {
    const out: unknown[] = [];
    while (pos < lines.length) {
      skip();
      if (pos >= lines.length) break;
      const line = lines[pos];
      const cur = indentOf(line);
      if (cur < indent) break;
      if (cur > indent) break;
      const trimmed = line.trimStart();
      if (!trimmed.startsWith("- ")) break;
      const after = trimmed.slice(2);
      pos++;
      if (after === "") {
        out.push(parseNode(indent + 1));
        continue;
      }
      if (after.startsWith("[") || after.startsWith("{")) {
        out.push(parseInlineAny(after));
        continue;
      }
      const colon = findColon(after);
      if (colon < 0 || after.startsWith('"') || after.startsWith("'")) {
        out.push(parseScalar(after));
        continue;
      }
      // "- key: val" begins an inline-mapping item that may span more lines.
      const key = after.slice(0, colon).trim().replace(/^["']|["']$/g, "");
      const val = after.slice(colon + 1).trim();
      const item: Record<string, unknown> = {};
      if (val === "|" || val === ">" || val.endsWith("|") || val.endsWith(">")) {
        item[key] = readBlockScalar(val.trim()[0]);
      } else if (val === "") {
        item[key] = parseNode(indent + 1) ?? null;
      } else if (val.startsWith("[") || val.startsWith("{")) {
        item[key] = parseInlineAny(val);
      } else {
        item[key] = parseScalar(val);
      }
      while (pos < lines.length) {
        skip();
        if (pos >= lines.length) break;
        const l2 = lines[pos];
        const i2 = indentOf(l2);
        if (i2 <= indent) break;
        const t2 = l2.trimStart();
        if (t2.startsWith("- ")) break;
        const c2 = findColon(t2);
        if (c2 < 0) {
          pos++;
          continue;
        }
        const k2 = t2.slice(0, c2).trim().replace(/^["']|["']$/g, "");
        const r2 = t2.slice(c2 + 1).trim();
        pos++;
        if (r2 === "|" || r2 === ">" || r2.endsWith("|") || r2.endsWith(">")) {
          item[k2] = readBlockScalar(r2.trim()[0]);
        } else if (r2 === "") {
          item[k2] = parseNode(i2 + 1) ?? null;
        } else if (r2.startsWith("[") || r2.startsWith("{")) {
          item[k2] = parseInlineAny(r2);
        } else {
          item[k2] = parseScalar(r2);
        }
      }
      out.push(item);
    }
    return out;
  }

  return parseNode(0);
}

/* ------------------------------------------------------------------ *
 * OpenAPI spec -> SymbolDoc[]                                         *
 * ------------------------------------------------------------------ */

function refName(ref: string): string {
  const parts = ref.split("/");
  return parts[parts.length - 1] || "unknown";
}

function resolveRef(doc: Record<string, any>, ref: string): any {
  if (typeof ref !== "string" || !ref.startsWith("#/")) return undefined;
  let cur: any = doc;
  for (const p of ref.slice(2).split("/")) {
    if (cur == null) return undefined;
    cur = cur[p];
  }
  return cur;
}

function schemaType(schema: any, doc: Record<string, any>): string {
  if (!schema) return "unknown";
  if (typeof schema === "string") return schema;
  if (schema.$ref) {
    const r = resolveRef(doc, schema.$ref);
    return (r && (r.title || r["x-name"])) || refName(schema.$ref);
  }
  if (Array.isArray(schema.allOf) || Array.isArray(schema.oneOf) || Array.isArray(schema.anyOf)) {
    return "union";
  }
  if (schema.type === "array") return `${schemaType(schema.items, doc)}[]`;
  if (schema.type) return String(schema.type);
  if (schema.properties || schema.additionalProperties) return "object";
  return "unknown";
}

function pascal(s: string): string {
  return s
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean)
    .map((p) => p.charAt(0).toUpperCase() + p.slice(1))
    .join("");
}

function paramFromSpec(p: any, doc: Record<string, any>): SymbolDoc["params"][number] {
  return {
    name: String(p.name),
    type: p.schema ? schemaType(p.schema, doc) : "string",
    description: p.description,
    optional: p.required !== true,
  };
}

function parseOpenApi(doc: Record<string, any>, sourceFile: string): SymbolDoc[] {
  const paths = (doc.paths ?? {}) as Record<string, Record<string, any>>;
  const out: SymbolDoc[] = [];
  const methods = ["get", "post", "put", "patch", "delete", "options", "head", "trace"];
  for (const [route, ops] of Object.entries(paths)) {
    for (const [method, op] of Object.entries(ops)) {
      if (!methods.includes(method) || typeof op !== "object" || op == null) continue;
      const name = (op.operationId as string) || `${method}${pascal(route)}`;
      const params: SymbolDoc["params"] = [];
      for (const p of op.parameters ?? []) params.push(paramFromSpec(p, doc));
      const body = op.requestBody?.content?.["application/json"]?.schema;
      if (body) {
        params.push({
          name: "body",
          type: schemaType(body, doc),
          description: "Request body (application/json)",
          optional: op.requestBody?.required !== true,
        });
      }
      let returns: SymbolDoc["returns"] | undefined;
      const respKey = Object.keys(op.responses ?? {}).find((k) => k.startsWith("2")) ?? "default";
      const resp = op.responses?.[respKey];
      const respSchema = resp?.content?.["application/json"]?.schema;
      if (respSchema) returns = { type: schemaType(respSchema, doc) };
      out.push({
        name,
        kind: "function",
        signature: `${method.toUpperCase()} ${route}`,
        description: (op.summary as string) || (op.description as string),
        params,
        returns,
        examples: [],
        deprecated: op.deprecated === true ? true : undefined,
        sourceFile,
      });
    }
  }
  return out;
}

function findOpenApiFile(root: string): string | undefined {
  const candidates = [
    "openapi.json",
    "openapi.yaml",
    "openapi.yml",
    "swagger.json",
    "swagger.yaml",
    "swagger.yml",
  ];
  for (const c of candidates) {
    if (fs.existsSync(path.join(root, c))) return c;
  }
  try {
    for (const f of fs.readdirSync(root)) {
      if (/^.*\.openapi\.(json|yaml|yml)$/.test(f)) return f;
    }
  } catch {
    /* ignore */
  }
  return undefined;
}

export const openApiAdapter: LanguageAdapter = {
  id: "openapi",
  detect(ctx) {
    return findOpenApiFile(ctx.root) !== undefined;
  },
  extract(ctx) {
    const file = findOpenApiFile(ctx.root);
    if (!file) return [];
    const raw = fs.readFileSync(path.join(ctx.root, file), "utf8");
    let doc: Record<string, any>;
    try {
      doc = file.endsWith(".json")
        ? JSON.parse(raw)
        : (parseYaml(raw) as Record<string, any>);
    } catch (err) {
      console.warn(
        `[brewdocs] OpenAPI parse failed for "${file}": ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      return [];
    }
    if (!doc || typeof doc !== "object" || !doc.paths) {
      console.warn(`[brewdocs] "${file}" is not a recognized OpenAPI document — skipping`);
      return [];
    }
    return parseOpenApi(doc, file).sort((a, b) => a.name.localeCompare(b.name));
  },
};
