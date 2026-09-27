import * as fs from "node:fs";
import * as path from "node:path";
import type { MemberDoc, ParamDoc, SymbolDoc } from "../types.js";
import type { LanguageAdapter } from "../plugins.js";

/**
 * Static Python extractor — the default. Line-based, no interpreter, no
 * subprocess: parsing is a pure function of the file bytes, so it is safe on
 * any source (fetched included) and needs nothing installed. The accurate
 * `ast`-based adapter is opt-in via `--plugins python-ast` (it executes a
 * bundled helper and refuses fetched sources — finding #15).
 *
 * Heuristic by design: multi-line signatures and exotic decorators degrade to
 * "symbol skipped", never a crash. Type annotations map to TS-ish types so the
 * renderer/diff work unchanged.
 */

const PY_TYPES: Record<string, string> = {
  str: "string",
  unicode: "string",
  int: "number",
  float: "number",
  complex: "number",
  bool: "boolean",
  None: "void",
  bytes: "Uint8Array",
  list: "Array",
  dict: "Record",
  object: "unknown",
  any: "any",
};

function mapPyType(t: string | undefined): string | undefined {
  if (!t) return undefined;
  const s = t.trim();
  const opt = /^Optional\[(.+)\]$/.exec(s);
  if (opt) return `${mapPyType(opt[1])} | undefined`;
  if (s.includes("|")) {
    return s
      .split("|")
      .map((piece) => (piece.trim() === "None" ? "undefined" : mapPyType(piece)))
      .join(" | ");
  }
  const bracket = s.indexOf("[");
  if (bracket === -1) return PY_TYPES[s] ?? s;
  return (PY_TYPES[s.slice(0, bracket)] ?? s.slice(0, bracket)) + s.slice(bracket);
}

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

function parsePyParams(list: string): ParamDoc[] {
  const out: ParamDoc[] = [];
  for (const part of splitTopLevel(list, ",").map((p) => p.trim()).filter(Boolean)) {
    if (["self", "cls", "*", "/"].includes(part)) continue;
    const star = part.startsWith("**") ? "**" : part.startsWith("*") ? "*" : "";
    const body = part.replace(/^\*\*?/, "");
    const eq = body.indexOf("=");
    let head = eq === -1 ? body : body.slice(0, eq);
    const def = eq === -1 ? undefined : body.slice(eq + 1).trim();
    const colon = head.indexOf(":");
    let type: string | undefined;
    if (colon !== -1) {
      type = mapPyType(head.slice(colon + 1));
      head = head.slice(0, colon);
    }
    const name = head.trim();
    if (!name) continue;
    out.push({ name: star + name, type, optional: Boolean(def || star), default: def });
  }
  return out;
}

/** First-paragraph summary of a docstring. */
function summaryOf(doc: string | undefined): string | undefined {
  if (!doc) return undefined;
  const lines = doc.split("\n").map((l) => l.trim());
  const para: string[] = [];
  for (const l of lines) {
    if (l === "") break;
    para.push(l);
  }
  return para.join(" ").trim() || undefined;
}

/** Triple-quoted docstring starting at/after `start`; returns its text. */
function docstringAt(lines: string[], start: number): string | undefined {
  let i = start;
  while (i < lines.length && lines[i].trim() === "") i++;
  if (i >= lines.length) return undefined;
  const m = /^("""|''')(.*)$/.exec(lines[i].trim());
  if (!m) return undefined;
  const quote = m[1];
  const first = m[2];
  if (first.endsWith(quote) && first.length >= quote.length) {
    return first.slice(0, -quote.length).trim();
  }
  const collected = [first];
  for (let j = i + 1; j < lines.length; j++) {
    const idx = lines[j].indexOf(quote);
    if (idx !== -1) {
      collected.push(lines[j].slice(0, idx));
      break;
    }
    collected.push(lines[j]);
  }
  return collected.join("\n").trim();
}

function decoratorName(raw: string): string {
  const s = raw.trim();
  return s.includes("(") ? `${s.slice(0, s.indexOf("("))}(...)` : s;
}

/** `@deprecated` decorator or a Sphinx `.. deprecated::` docstring directive. */
function deprecatedOf(doc: string | undefined, decorators: string[]): string | boolean | undefined {
  if (decorators.some((d) => /deprecated/i.test(d))) return true;
  if (!doc) return undefined;
  for (const line of doc.split("\n")) {
    if (line.trim().toLowerCase().startsWith(".. deprecated::")) {
      const idx = line.indexOf("::");
      return (idx === -1 ? "" : line.slice(idx + 2).trim()) || true;
    }
  }
  return undefined;
}

function readClassBody(lines: string[], start: number): MemberDoc[] {
  const members: MemberDoc[] = [];
  for (let i = start; i < lines.length; i++) {
    const raw = lines[i];
    const t = raw.trim();
    if (!t || t.startsWith("#") || t.startsWith("@")) continue;
    const indent = raw.length - raw.trimStart().length;
    if (indent === 0) break;
    const m = /^(?:async\s+)?def\s+(\w+)\s*\(([^)]*)\)\s*(?:->\s*(.+?))?\s*:$/.exec(t);
    if (m) {
      const ret = mapPyType(m[3]);
      members.push({
        name: m[1],
        kind: "method",
        signature: ret ? `${m[1]}(${m[2].trim()}) -> ${ret}` : t,
      });
      continue;
    }
    const p = /^(\w+)\s*(?::\s*([^=]+))?\s*=/.exec(t);
    if (p) members.push({ name: p[1], kind: "property", type: mapPyType(p[2]) });
  }
  return members;
}

interface PySymbol {
  name: string;
  kind: "function" | "class" | "constant";
  signature?: string;
  description?: string;
  params: ParamDoc[];
  returns?: { type?: string };
  members?: MemberDoc[];
  decorators?: string[];
  deprecated?: string | boolean;
  sourceFile: string;
}

function parsePyFile(src: string, rel: string): PySymbol[] {
  const lines = src.split(/\r?\n/);
  const out: PySymbol[] = [];
  let decorators: string[] = [];

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    const t = raw.trim();
    if (!t || t.startsWith("#")) continue;
    const indent = raw.length - raw.trimStart().length;

    if (indent === 0 && t.startsWith("@")) {
      decorators.push(decoratorName(t.slice(1)));
      continue;
    }

    const defM = /^(?:async\s+)?def\s+(\w+)\s*\(([^)]*)\)\s*(?:->\s*(.+?))?\s*:$/.exec(t);
    if (indent === 0 && defM) {
      const ret = mapPyType(defM[3]);
      const doc = docstringAt(lines, i + 1);
      out.push({
        name: defM[1],
        kind: "function",
        signature: t,
        description: summaryOf(doc),
        params: parsePyParams(defM[2]),
        returns: ret ? { type: ret } : undefined,
        decorators: decorators.length ? decorators : undefined,
        deprecated: deprecatedOf(doc, decorators),
        sourceFile: rel,
      });
      decorators = [];
      continue;
    }

    const classM = /^class\s+(\w+)\s*(?:\(([^)]*)\))?\s*:$/.exec(t);
    if (indent === 0 && classM) {
      const members = readClassBody(lines, i + 1);
      const doc = docstringAt(lines, i + 1);
      out.push({
        name: classM[1],
        kind: "class",
        signature: t,
        description: summaryOf(doc),
        params: [],
        members: members.length ? members : undefined,
        decorators: decorators.length ? decorators : undefined,
        deprecated: deprecatedOf(doc, decorators),
        sourceFile: rel,
      });
      decorators = [];
      continue;
    }

    const constM = /^([A-Za-z_]\w*)\s*(?::\s*([^=]+))?\s*=\s*(.+)$/.exec(t);
    if (indent === 0 && constM) {
      const type = mapPyType(constM[2]);
      out.push({
        name: constM[1],
        kind: "constant",
        signature: type ? `${constM[1]}: ${type}` : t,
        params: [],
        sourceFile: rel,
      });
    }
    decorators = [];
  }

  // Public API convention: a leading underscore is private.
  return out.filter((s) => !s.name.startsWith("_"));
}

function walkPyFiles(root: string): { files: string[]; base: string } {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return { files: [], base: root };
  }
  const pkg = entries.find(
    (e) => e.isDirectory() && fs.existsSync(path.join(root, e.name, "__init__.py")),
  );
  const files: string[] = [];
  if (pkg) {
    const stack = [path.join(root, pkg.name)];
    while (stack.length) {
      const dir = stack.pop()!;
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        if (e.isDirectory() && e.name !== "__pycache__") stack.push(path.join(dir, e.name));
        else if (e.isFile() && e.name.endsWith(".py")) files.push(path.join(dir, e.name));
      }
    }
  } else {
    for (const e of entries) {
      if (e.isFile() && e.name.endsWith(".py") && !e.name.startsWith("test_")) {
        files.push(path.join(root, e.name));
      }
    }
  }
  return { files: files.sort(), base: pkg ? path.join(root, pkg.name) : root };
}

export function looksLikePythonPackage(root: string): boolean {
  if (fs.existsSync(path.join(root, "pyproject.toml"))) return true;
  if (fs.existsSync(path.join(root, "setup.py"))) return true;
  try {
    const entries = fs.readdirSync(root, { withFileTypes: true });
    if (entries.some((e) => e.isFile() && e.name.endsWith(".py") && !e.name.startsWith("test_")))
      return true;
    if (entries.some((e) => e.isDirectory() && fs.existsSync(path.join(root, e.name, "__init__.py"))))
      return true;
  } catch {
    /* unreadable dir */
  }
  return false;
}

export const pythonStaticAdapter: LanguageAdapter = {
  id: "python",
  detect(ctx) {
    return looksLikePythonPackage(ctx.root);
  },
  extract(ctx) {
    const root = path.resolve(ctx.root);
    const { files } = walkPyFiles(root);
    const out: SymbolDoc[] = [];
    const seen = new Set<string>();
    for (const file of files) {
      let syms: PySymbol[];
      try {
        syms = parsePyFile(fs.readFileSync(file, "utf8"), path.relative(root, file).replace(/\\/g, "/"));
      } catch {
        continue;
      }
      for (const s of syms) {
        if (seen.has(s.name)) continue;
        seen.add(s.name);
        out.push({
          name: s.name,
          kind: s.kind,
          signature: s.signature,
          description: s.description,
          params: s.params,
          returns: s.returns,
          examples: [],
          sourceFile: s.sourceFile,
          members: s.members,
          decorators: s.decorators,
          deprecated: s.deprecated,
        });
      }
    }
    return out.sort((a, b) => a.name.localeCompare(b.name));
  },
};
