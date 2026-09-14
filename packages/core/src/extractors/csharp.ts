import * as fs from "node:fs";
import * as path from "node:path";
import type { MemberDoc, ParamDoc, SymbolDoc } from "../types.js";
import type { LanguageAdapter } from "../plugins.js";
import { walkSourceFiles, readDeclHead } from "./walk.js";

/**
 * v3.0 C# extractor: static analysis of `.cs` sources (same heuristic level
 * as Java — no Roslyn). Public types become class/interface symbols with
 * property/field members; public methods flatten to `Type.Method` function
 * symbols. XML doc comments (`<summary>`, `<param>`, `<returns>`,
 * `<exception>`, `<see>`) fill the model; `[Obsolete]` marks deprecation.
 */

interface CsDoc {
  description?: string;
  params: Map<string, string>;
  returns?: string;
  throws: string[];
  see: string[];
}

function parseXmlDoc(commentLines: string[]): CsDoc {
  const joined = commentLines
    .map((l) => l.replace(/^\s*\/\/\/\s?/, "").trim())
    .join(" ");
  const strip = (s: string) =>
    s
      .replace(/<[^>]+>/g, "")
      .replace(/\s+/g, " ")
      .trim();
  const doc: CsDoc = { params: new Map(), throws: [], see: [] };
  const sum = /<summary>([\s\S]*?)<\/summary>/.exec(joined);
  if (sum) doc.description = strip(sum[1]) || undefined;
  for (const m of joined.matchAll(/<param\s+name="([^"]+)"[^>]*>([\s\S]*?)<\/param>/g)) {
    doc.params.set(m[1], strip(m[2]));
  }
  const ret = /<returns>([\s\S]*?)<\/returns>/.exec(joined);
  if (ret) doc.returns = strip(ret[1]);
  for (const m of joined.matchAll(/<exception\s+cref="([^"]+)"[^>]*>([\s\S]*?)<\/exception>/g)) {
    doc.throws.push(`${m[1].replace(/^[T|:]*/, "").split(".").pop()} ${strip(m[2])}`.trim());
  }
  for (const m of joined.matchAll(/<see\s+cref="([^"]+)"/g)) {
    doc.see.push(m[1].replace(/^[T|:]*/, "").split(".").pop()!);
  }
  return doc;
}

function splitTopLevel(list: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let cur = "";
  for (const ch of list) {
    if ("([{<".includes(ch)) depth++;
    else if (")]}".includes(ch)) depth--;
    if (ch === "," && depth <= 0) {
      parts.push(cur);
      cur = "";
    } else cur += ch;
  }
  parts.push(cur);
  return parts.map((p) => p.trim()).filter(Boolean);
}

function parseCsParams(list: string, doc: CsDoc | null): ParamDoc[] {
  const params: ParamDoc[] = [];
  for (let part of splitTopLevel(list)) {
    part = part.replace(/\b(out|ref|in|params|this)\s+/g, "").trim();
    if (!part) continue;
    let dflt: string | undefined;
    const eq = part.indexOf("=");
    if (eq > -1) {
      dflt = part.slice(eq + 1).trim();
      part = part.slice(0, eq).trim();
    }
    const m = /^(.*?)\s+(\w+)$/.exec(part);
    if (m && m[1].trim()) {
      params.push({
        name: m[2],
        type: m[1].trim(),
        description: doc?.params.get(m[2]),
        optional: dflt !== undefined || undefined,
        default: dflt,
      });
    } else {
      params.push({ name: part, description: doc?.params.get(part) });
    }
  }
  return params;
}

const MODS =
  "(?:(?:public|private|protected|internal|static|virtual|override|abstract|sealed|readonly|async|new|extern|unsafe|partial|required|const)\\s+)*";
const TYPE_RE = new RegExp(
  `^public\\s+${MODS}(class|interface|struct|enum|record)\\s+(\\w+)(?:<[^>{]*>)?(?:\\([^)]*\\))?[^{;]*?([{;])$`,
);
const METHOD_RE = new RegExp(
  `^public\\s+${MODS}([\\w.<>\\[\\],\\?]+)\\s+(\\w+)\\s*\\((.*)\\)\\s*(?:=>[^;{]*)?([;{])$`,
);
const OPERATORISH_RE = /^(?:public|protected|internal)\s+/;
const CTOR_RE = /^public\s+(\w+)\s*\((.*)\)\s*(?::[^{;]+)?([;{])$/;
const PROPERTY_RE = new RegExp(
  `^public\\s+${MODS}(?:new\\s+)?([\\w.<>\\[\\],?]+)\\s+(\\w+)\\s*\\{`,
);
const FIELD_RE = new RegExp(
  `^public\\s+${MODS}([\\w.<>\\[\\],?]+)\\s+(\\w+)\\s*(?:=>[^;]*)?(?:=[^;]*)?;$`,
);
const ENUM_MEMBER_RE = /^(\w+)\s*(?:=\s*[^,;]+)?\s*[,;]?$/;

interface ParsedDecl {
  name: string;
  kind: SymbolDoc["kind"];
  signature?: string;
  description?: string;
  params?: ParamDoc[];
  returns?: { type?: string; description?: string };
  throws?: string[];
  see?: string[];
  members?: MemberDoc[];
  deprecated?: string | boolean;
}

function readHead(lines: string[], start: number): { head: string; end: number } {
  return readDeclHead(lines, start, (t) => t.startsWith("//"));
}

function blockEnd(lines: string[], start: number): number {
  let depth = 0;
  let seen = false;
  for (let i = start; i < lines.length; i++) {
    for (const ch of lines[i]) {
      if (ch === "{") {
        depth++;
        seen = true;
      } else if (ch === "}") depth--;
    }
    if (seen && depth <= 0) return i;
  }
  return lines.length - 1;
}

/** Collect a run of `///` lines starting at `i`. */
function takeDoc(lines: string[], i: number): { doc: CsDoc | null; next: number } {
  if (!lines[i].trim().startsWith("///")) return { doc: null, next: i };
  const block: string[] = [];
  let j = i;
  for (; j < lines.length; j++) {
    if (!lines[j].trim().startsWith("///")) break;
    block.push(lines[j]);
  }
  return { doc: parseXmlDoc(block), next: j };
}

function typeKind(j: string): SymbolDoc["kind"] {
  return j === "interface" ? "interface" : "class";
}

function parseTypeBody(
  body: string[],
  typeName: string,
  kind: SymbolDoc["kind"],
  isEnum: boolean,
): { members: MemberDoc[]; methods: ParsedDecl[]; nested: ParsedDecl[] } {
  const members: MemberDoc[] = [];
  const methods: ParsedDecl[] = [];
  const nested: ParsedDecl[] = [];
  let i = 0;
  let doc: CsDoc | null = null;
  let deprecated: string | boolean | undefined;

  while (i < body.length) {
    const t = body[i].trim();
    if (!t || t.startsWith("using ") || t.startsWith("}")) {
      i++;
      continue;
    }
    if (t.startsWith("///")) {
      const r = takeDoc(body, i);
      doc = r.doc;
      i = r.next;
      continue;
    }
    if (t.startsWith("//") || t.startsWith("/*")) {
      i++;
      continue;
    }
    if (t.startsWith("[")) {
      const ob = /^\[Obsolete\((?:"([^"]*)"|message\s*:\s*"([^"]*)")?/.exec(t);
      if (ob) deprecated = ob[1] ?? ob[2] ?? true;
      i++;
      continue;
    }

    const head = readHead(body, i);
    let end = head.end;
    if (head.head.endsWith("{")) end = blockEnd(body, head.end);
    else if (/\{\s*\}\s*$/.test(head.head)) end = head.end;
    i = end + 1;
    // fold `{ }` single-line bodies so the `[;{]$` regexes still anchor
    let text = head.head.replace(/\s*\{\s*\}\s*;?\s*$/, " {");
    const currentDoc = doc;
    const currentDeprecated = deprecated;
    doc = null;
    deprecated = undefined;

    let m = TYPE_RE.exec(text);
    if (m) {
      const inner = body.slice(head.end + 1, end);
      const sub = parseTypeBody(inner, `${typeName}.${m[2]}`, typeKind(m[1]), m[1] === "enum");
      nested.push({
        name: `${typeName}.${m[2]}`,
        kind: typeKind(m[1]),
        signature: text.replace(/[;{]$/, "").trim(),
        description: currentDoc?.description,
        members: sub.members.length ? sub.members : undefined,
        deprecated: currentDeprecated,
      });
      nested.push(...sub.nested);
      methods.push(...sub.methods);
      continue;
    }
    if (isEnum) {
      m = ENUM_MEMBER_RE.exec(text);
      if (m && !OPERATORISH_RE.test(text)) {
        members.push({ name: m[1], kind: "property", type: "enum member" });
        continue;
      }
    }
    m = CTOR_RE.exec(text);
    if (m && m[1] === typeName.split(".").pop()) {
      members.push({
        name: m[1],
        kind: "constructor",
        signature: text.replace(/[;{]$/, "").trim(),
        description: currentDoc?.description,
        deprecated: currentDeprecated,
      });
      continue;
    }
    m = METHOD_RE.exec(text);
    if (m) {
      methods.push({
        name: `${typeName}.${m[2]}`,
        kind: "function",
        signature: text.replace(/[;{]$/, "").trim(),
        description: currentDoc?.description,
        params: parseCsParams(m[3], currentDoc),
        returns:
          m[1] && m[1] !== "void"
            ? { type: m[1].trim(), description: currentDoc?.returns }
            : currentDoc?.returns
              ? { description: currentDoc.returns }
              : undefined,
        throws: currentDoc?.throws.length ? currentDoc.throws : undefined,
        see: currentDoc?.see.length ? currentDoc.see : undefined,
        deprecated: currentDeprecated,
      });
      continue;
    }
    m = PROPERTY_RE.exec(text);
    if (m) {
      const accessors = body.slice(head.end, end + 1).join(" ");
      members.push({
        name: m[2],
        kind: "property",
        type: m[1].trim(),
        description: currentDoc?.description,
        static: /\bstatic\b/.test(text) || undefined,
        readonly: /\bget\b/.test(accessors) && !/\bset\b/.test(accessors) || undefined,
      });
      continue;
    }
    m = FIELD_RE.exec(text);
    if (m) {
      members.push({
        name: m[2],
        kind: "property",
        type: m[1].trim(),
        readonly: /\breadonly\b|\bconst\b/.test(text) || undefined,
        static: /\bstatic\b/.test(text) || undefined,
        description: currentDoc?.description,
      });
      continue;
    }
  }
  return { members, methods, nested };
}

function parseCsFile(src: string): ParsedDecl[] {
  const out: ParsedDecl[] = [];
  const lines = src.split(/\r?\n/);
  let doc: CsDoc | null = null;
  let deprecated: string | boolean | undefined;

  for (let i = 0; i < lines.length; i++) {
    const t = lines[i].trim();
    if (!t || t.startsWith("using ")) continue;
    if (t.startsWith("///")) {
      const r = takeDoc(lines, i);
      doc = r.doc;
      i = r.next - 1;
      continue;
    }
    if (t.startsWith("//") || t.startsWith("/*")) continue;
    if (t.startsWith("[")) {
      const ob = /^\[Obsolete\((?:"([^"]*)"|message\s*:\s*"([^"]*)")?/.exec(t);
      if (ob) deprecated = ob[1] ?? ob[2] ?? true;
      continue;
    }
    const head = readHead(lines, i);
    let end = head.end;
    if (head.head.endsWith("{")) end = blockEnd(lines, head.end);
    const m = TYPE_RE.exec(head.head);
    if (!m) {
      doc = null;
      deprecated = undefined;
      continue;
    }
    i = end;
    const kind = typeKind(m[1]);
    const body = lines.slice(head.end + 1, end);
    const parsed = parseTypeBody(body, m[2], kind, m[1] === "enum");
    out.push({
      name: m[2],
      kind,
      signature: head.head.replace(/[;{]$/, "").trim(),
      description: doc?.description,
      deprecated,
      members: parsed.members.length ? parsed.members : undefined,
    });
    out.push(...parsed.nested, ...parsed.methods);
    doc = null;
    deprecated = undefined;
  }
  return out;
}

function looksLikeCSharpProject(root: string): boolean {
  try {
    const entries = fs.readdirSync(root, { withFileTypes: true }).map((e) => e.name);
    if (entries.some((n) => n.endsWith(".csproj") || n.endsWith(".sln"))) return true;
  } catch {
    return false;
  }
  return walkSourceFiles(root, [".cs"], { maxDepth: 5 }).length > 0;
}

export const csharpAdapter: LanguageAdapter = {
  id: "csharp",
  detect(ctx) {
    return looksLikeCSharpProject(ctx.root);
  },
  extract(ctx) {
    const files = walkSourceFiles(ctx.root, [".cs"], { maxDepth: 8 }).filter(
      (f) => !/(Designer|\.g)\.cs$/.test(f) && !/[\\/](bin|obj)[\\/]/.test(f),
    );
    const decls: ParsedDecl[] = [];
    for (const f of files) {
      try {
        decls.push(...parseCsFile(fs.readFileSync(f, "utf8")));
      } catch {
        /* unreadable file: skip */
      }
    }
    const seen = new Set<string>();
    return decls
      .filter((d) => (seen.has(d.name) ? false : (seen.add(d.name), true)))
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((d) => ({
        name: d.name,
        kind: d.kind,
        signature: d.signature,
        description: d.description,
        params: d.params ?? [],
        returns: d.returns,
        throws: d.throws,
        see: d.see,
        examples: [],
        deprecated: d.deprecated,
        members: d.members?.length ? d.members : undefined,
      }));
  },
};
