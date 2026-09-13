import * as fs from "node:fs";
import * as path from "node:path";
import type { MemberDoc, ParamDoc, SymbolDoc } from "../types.js";
import type { LanguageAdapter } from "../plugins.js";

/**
 * v2.0 Go extractor: proves the adapter architecture on a second language.
 * Static analysis over the package's non-test `.go` files (same philosophy
 * as the Python adapter — no execution, no toolchain required): doc comments,
 * top-level functions/methods, struct and interface bodies, exported vars
 * and consts.
 */

function splitTopLevel(list: string, sep: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let cur = "";
  for (const ch of list) {
    if ("([{".includes(ch)) depth++;
    if (")]}".includes(ch)) depth--;
    if (ch === sep && depth === 0) {
      parts.push(cur);
      cur = "";
    } else cur += ch;
  }
  parts.push(cur);
  return parts;
}

/**
 * Map a Go parameter list to ParamDocs. Handles grouped types (`a, b int`)
 * and variadics (`rest ...string`); bare `a, b` groups inherit the following
 * entry's type per Go syntax.
 */
function parseGoParams(list: string): ParamDoc[] {
  const params: ParamDoc[] = [];
  const parts = splitTopLevel(list, ",").map((p) => p.trim()).filter(Boolean);
  const pendingNames: string[] = [];
  for (const part of parts) {
    const variadic = part.startsWith("...");
    const body = variadic ? part.slice(3).trim() : part;
    const m = /^([A-Za-z_]\w*)(?:\s+([\w()\[\]*.,\s]+|interface\{\}|map\[[^\]]*\][^\s]*))?/.exec(body);
    if (!m) continue;
    const [, first, second] = m;
    if (second) {
      const name = variadic ? `...${first}` : first;
      params.push({ name, type: second.trim(), optional: variadic });
      for (const pn of pendingNames.splice(0)) {
        params.push({ name: pn, type: second.trim() });
      }
    } else {
      pendingNames.push(variadic ? `...${first}` : first);
    }
  }
  return params;
}

interface ParsedDecl {
  name: string;
  kind: SymbolDoc["kind"];
  signature?: string;
  description?: string;
  params?: ParamDoc[];
  returns?: { type?: string };
  members?: MemberDoc[];
}

const FUNC_RE = /^func\s+([A-Z]\w*)\(([^)]*)\)(?:\s+([^{]+?))?\s*(?:\{|$)/;
const METH_RE = /^func\s+\(\w+\s+\*?(\w+)\)\s+([A-Z]\w*)\(([^)]*)\)(?:\s+([^{]+?))?\s*(?:\{|$)/;
const TYPE_BLOCK_RE = /^type\s+([A-Z]\w*)\s+(struct|interface)\s*\{/;
const TYPE_ALIAS_RE = /^type\s+([A-Z]\w*)\s+(\S.*)$/;
const VAR_CONST_RE = /^(?:var|const)\s+([A-Z]\w*)\s+(.+)$/;

/** One exported symbol per doc-comment-anchored top-level line. */
function parseGoFile(src: string, file: string): ParsedDecl[] {
  const out: ParsedDecl[] = [];
  const lines = src.split(/\r?\n/);
  let doc: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const cm = /^\s*\/\/\s?(.*)$/.exec(line);
    if (cm) {
      doc.push(cm[1].trim());
      continue;
    }
    const description = doc.filter(Boolean).join(" ") || undefined;
    doc = [];
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("//")) continue;

    let m = METH_RE.exec(trimmed);
    if (m) {
      out.push({
        name: `${m[1]}.${m[2]}`,
        kind: "function",
        signature: signatureUntilBrace(trimmed),
        description,
        params: parseGoParams(m[3]),
        returns: m[4] ? { type: m[4].trim() } : undefined,
      });
      continue;
    }
    m = FUNC_RE.exec(trimmed);
    if (m) {
      out.push({
        name: m[1],
        kind: "function",
        signature: signatureUntilBrace(trimmed),
        description,
        params: parseGoParams(m[2]),
        returns: m[3] ? { type: m[3].trim() } : undefined,
      });
      continue;
    }
    m = TYPE_BLOCK_RE.exec(trimmed);
    if (m) {
      const kind = m[2] as "struct" | "interface";
      const members = readTypeBody(lines, i, kind);
      i = members.end;
      out.push({
        name: m[1],
        kind: kind === "interface" ? "interface" : "class",
        signature: `type ${m[1]} ${kind} { … }`,
        description,
        members: members.list,
      });
      continue;
    }
    m = TYPE_ALIAS_RE.exec(trimmed);
    if (m && !/^\s*$/.test(m[2])) {
      out.push({
        name: m[1],
        kind: "type",
        signature: `type ${m[1]} ${m[2].trim()}`,
        description,
      });
      continue;
    }
    m = VAR_CONST_RE.exec(trimmed);
    if (m) {
      out.push({
        name: m[1],
        kind: "constant",
        signature: trimmed.replace(/\s*\/\/.*$/, "").trim(),
        description,
      });
      continue;
    }
  }
  return out;
}

function signatureUntilBrace(line: string): string {
  return line.replace(/\s*\{\s*$/, "").trim();
}

/** Collect exported struct fields / interface methods until the closing brace. */
function readTypeBody(
  lines: string[],
  start: number,
  kind: "struct" | "interface",
): { list: MemberDoc[]; end: number } {
  const list: MemberDoc[] = [];
  let i = start + 1;
  for (; i < lines.length; i++) {
    const t = lines[i].trim();
    if (/^\}/.test(t)) break;
    if (!t || t.startsWith("//")) continue;
    if (kind === "struct") {
      const fm = /^([A-Z]\w*)(?:\s+([^\s`]+))(?:\s+`[^`]*`)?\s*(?:=.*)?$/.exec(t);
      if (fm && fm[2]) list.push({ name: fm[1], kind: "property", type: fm[2] });
    } else {
      const mm = /^([A-Z]\w*)\(([^)]*)\)(?:\s+([^{]+))?$/.exec(t);
      if (mm) {
        list.push({ name: mm[1], kind: "method", signature: t });
      } else {
        const em = /^([A-Z]\w*)\s*$/.exec(t);
        if (em) list.push({ name: em[1], kind: "property", description: "embedded" });
      }
    }
  }
  return { list, end: i };
}

function looksLikeGoModule(root: string): boolean {
  if (fs.existsSync(path.join(root, "go.mod"))) return true;
  try {
    return fs
      .readdirSync(root, { withFileTypes: true })
      .some((e) => e.isFile() && e.name.endsWith(".go"));
  } catch {
    return false;
  }
}

export const goAdapter: LanguageAdapter = {
  id: "go",
  detect(ctx) {
    return looksLikeGoModule(ctx.root);
  },
  extract(ctx) {
    const root = path.resolve(ctx.root);
    const decls: ParsedDecl[] = [];
    let files: string[];
    try {
      files = fs.readdirSync(root, { withFileTypes: false }).map(String);
    } catch {
      return [];
    }
    for (const f of files) {
      if (!f.endsWith(".go") || f.endsWith("_test.go")) continue;
      try {
        decls.push(...parseGoFile(fs.readFileSync(path.join(root, f), "utf8"), f));
      } catch {
        /* unreadable file: skip */
      }
    }
    const seen = new Set<string>();
    return decls
      .filter((d) => (seen.has(d.name) ? false : seen.add(d.name)))
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((d) => ({
        name: d.name,
        kind: d.kind,
        signature: d.signature,
        description: d.description,
        params: d.params ?? [],
        returns: d.returns,
        examples: [],
        sourceFile: undefined,
        members: d.members?.length ? d.members : undefined,
      }));
  },
};
