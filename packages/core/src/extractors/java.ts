import * as fs from "node:fs";
import * as path from "node:path";
import type { MemberDoc, ParamDoc, SymbolDoc } from "../types.js";
import type { LanguageAdapter } from "../plugins.js";
import { walkSourceFiles, readDeclHead } from "./walk.js";

/**
 * v3.0 Java extractor: static analysis of `.java` sources (heuristic like
 * Go/Rust — no javadoc toolchain). Public types become class/interface
 * symbols with field members; public methods are flattened to `Type.method`
 * function symbols (Go convention) so params, `@return`, `@throws` and
 * `@deprecated` land in the model. Test sources and build output are skipped.
 */

interface JavaDoc {
  description?: string;
  params: Map<string, string>;
  returns?: string;
  throws: string[];
  deprecated?: string | boolean;
  see: string[];
}

function parseJavadoc(block: string[]): JavaDoc {
  const doc: JavaDoc = { params: new Map(), throws: [], see: [] };
  const desc: string[] = [];
  let tag: string | null = null;
  for (const raw of block) {
    const t = raw
      .trim()
      .replace(/^\/\*\*?/, "")
      .replace(/\*\/$/, "")
      .replace(/^\*+/, "")
      .trim();
    const m = /^@(\w+)\s*(.*)$/.exec(t);
    if (m) {
      tag = m[1];
      const rest = m[2].trim();
      if (tag === "param") {
        const pm = /^(\S+)\s+(.*)$/.exec(rest);
        if (pm) doc.params.set(pm[1], pm[2].trim());
      } else if (tag === "return") {
        doc.returns = rest;
      } else if (tag === "throws" || tag === "exception") {
        doc.throws.push(rest);
      } else if (tag === "deprecated") {
        doc.deprecated = rest || true;
      } else if (tag === "see") {
        doc.see.push(rest);
      }
      continue;
    }
    if (!t) continue;
    if (!tag) desc.push(t.replace(/<\/?p>/g, "").trim());
    else if (tag === "param" || tag === "return" || tag === "deprecated") {
      // continuation lines of a wrapped tag value
      if (tag === "return") doc.returns = `${doc.returns ?? ""} ${t}`.trim();
    }
  }
  doc.description = desc.filter(Boolean).join(" ") || undefined;
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

function parseJavaParams(list: string, doc: JavaDoc | null): ParamDoc[] {
  const params: ParamDoc[] = [];
  for (let part of splitTopLevel(list)) {
    part = part.replace(/@\w+(\([^)]*\))?\s+/g, "").trim();
    if (!part) continue;
    const variadic = /\.\.\./.test(part);
    const m = /^(.*?)\s(\w+)$/.exec(part);
    if (m && m[1].trim()) {
      params.push({
        name: m[2],
        type: m[1].trim().replace(/\s*\.\.\./, ""),
        optional: variadic || undefined,
        description: doc?.params.get(m[2]),
      });
    } else {
      params.push({ name: part, description: doc?.params.get(part) });
    }
  }
  return params;
}

const MODS =
  "(?:(?:public|protected|private|static|final|abstract|synchronized|native|default|strictfp|sealed|non-sealed)\\s+)*";
const TYPE_RE = new RegExp(
  `^public\\s+${MODS}(class|interface|enum|record|@interface)\\s+(\\w+)(?:<[^{]*>)?[^{;]*?([{;])$`,
);
const CTOR_RE = /^public\s+(\w+)\s*\((.*)\)\s*(?:throws\s+[\w.,\s]+?)?\s*([{;])$/;
const METHOD_RE = new RegExp(
  `^public\\s+${MODS}(?:<[^>]+>\\s+)?([\\w.<>\\[\\],?\\s]+?)\\s+(\\w+)\\s*\\((.*)\\)\\s*(?:throws\\s+([\\w.,\\s]+?))?\\s*([{;])$`,
);
const BARE_METHOD_RE = /^(?:<[^>]+>\s+)?([\w.<>[\],?\s]+?)\s+(\w+)\s*\((.*)\)\s*(?:throws\s+[\w.,\s]+?)?\s*([{;])$/;
const FIELD_RE = /^public\s+(?:static\s+)?(final\s+)?([\w.<>[\],?]+(?:<[^>]*>)?(?:\[\])*)\s+(\w+)\s*(?:=[^;]*)?;$/;
const ENUM_CONST_RE = /^([A-Z][A-Z0-9_]*)\s*(?:\([^;]*\))?\s*[,;]?$/;

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

/** Fold physical lines from `start` into one logical declaration line. */
function readHead(lines: string[], start: number): { head: string; end: number } {
  return readDeclHead(lines, start, (t) => t.startsWith("//") || t.startsWith("*"));
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

/** Consume a `/** … *&#47;` block starting at `i`; returns next line index. */
function takeDoc(lines: string[], i: number): { doc: JavaDoc | null; next: number } {
  const t = lines[i].trim();
  if (!t.startsWith("/**")) return { doc: null, next: i };
  const block: string[] = [];
  for (let j = i; j < lines.length; j++) {
    block.push(lines[j]);
    if (j > i || /\*\/\s*$/.test(lines[i])) {
      if (block[block.length - 1].includes("*/")) return { doc: parseJavadoc(block), next: j + 1 };
    }
  }
  return { doc: parseJavadoc(block), next: lines.length };
}

function typeKind(j: string): SymbolDoc["kind"] {
  return j === "interface" || j === "@interface" ? "interface" : "class";
}

/** Parse a type body: field members, nested types; methods/ctors surface separately. */
function parseTypeBody(
  body: string[],
  typeName: string,
  kind: SymbolDoc["kind"],
  isEnum: boolean,
): { members: MemberDoc[]; nested: ParsedDecl[]; methods: ParsedDecl[] } {
  const members: MemberDoc[] = [];
  const nested: ParsedDecl[] = [];
  const methods: ParsedDecl[] = [];
  const implicitPublic = kind === "interface";
  const enumConstants: MemberDoc[] = [];

  let i = 0;
  let doc: JavaDoc | null = null;
  let deprecated: string | boolean | undefined;

  while (i < body.length) {
    const t = body[i].trim();
    if (!t || t.startsWith("//") || t.startsWith("import ") || t.startsWith("package ")) {
      i++;
      continue;
    }
    if (t.startsWith("/*")) {
      const r = takeDoc(body, i);
      if (r.doc) doc = r.doc;
      i = r.next;
      continue;
    }
    if (t.startsWith("@")) {
      if (/@Deprecated\b/.test(t)) {
        const mm = /@Deprecated\s*\(\s*(?:value\s*=\s*)?"([^"]*)"/.exec(t);
        deprecated = mm ? mm[1] : true;
      }
      i++;
      continue;
    }

    if (isEnum && !enumConstantsDone(body, i) && ENUM_CONST_RE.test(t)) {
      const em = ENUM_CONST_RE.exec(t)!;
      enumConstants.push({ name: em[1], kind: "property", type: "enum constant" });
      i++;
      continue;
    }

    const head = readHead(body, i);
    let end = head.end;
    if (head.head.endsWith("{")) end = blockEnd(body, head.end);
    i = end + 1;
    // fold `{ }` single-line bodies so the `[;{]$` regexes still anchor
    const text = head.head.replace(/\s*\{\s*\}\s*$/, " {");
    const currentDoc = doc;
    const currentDeprecated = deprecated ?? doc?.deprecated;
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
    if (!m && implicitPublic && !/^(?:public|private|protected)/.test(text)) {
      const bm = BARE_METHOD_RE.exec(text);
      if (bm) m = bm as unknown as RegExpExecArray;
    }
    if (m) {
      const retType = m[1].trim();
      methods.push({
        name: `${typeName}.${m[2]}`,
        kind: "function",
        signature: text.replace(/[;{]$/, "").trim(),
        description: currentDoc?.description,
        params: parseJavaParams(m[3], currentDoc),
        returns:
          retType && retType !== "void"
            ? { type: retType, description: currentDoc?.returns }
            : currentDoc?.returns
              ? { description: currentDoc.returns }
              : undefined,
        throws: currentDoc?.throws.length ? currentDoc.throws : undefined,
        see: currentDoc?.see.length ? currentDoc.see : undefined,
        deprecated: currentDeprecated,
      });
      continue;
    }
    m = FIELD_RE.exec(text);
    if (m) {
      members.push({
        name: m[3],
        kind: "property",
        type: m[2].trim(),
        readonly: Boolean(m[1]) || undefined,
        static: /\bstatic\b/.test(text) || undefined,
        description: currentDoc?.description ?? currentDoc?.params.get(m[3]),
      });
      continue;
    }
  }
  return { members: [...enumConstants, ...members], nested, methods };
}

/** enum constants only run until the first `;` line at body start level. */
function enumConstantsDone(body: string[], i: number): boolean {
  for (let j = 0; j < i; j++) {
    if (/;\s*$/.test(body[j].trim())) return true;
  }
  return false;
}

function parseJavaFile(src: string): ParsedDecl[] {
  const out: ParsedDecl[] = [];
  const lines = src.split(/\r?\n/);
  let doc: JavaDoc | null = null;
  let deprecated: string | boolean | undefined;

  for (let i = 0; i < lines.length; i++) {
    const t = lines[i].trim();
    if (!t || t.startsWith("package ") || t.startsWith("import ")) continue;
    if (t.startsWith("/*")) {
      const r = takeDoc(lines, i);
      if (r.doc) doc = r.doc;
      i = r.next - 1;
      continue;
    }
    if (t.startsWith("//")) continue;
    if (t.startsWith("@")) {
      if (/@Deprecated\b/.test(t)) {
        const mm = /@Deprecated\s*\(\s*(?:value\s*=\s*)?"([^"]*)"/.exec(t);
        deprecated = mm ? mm[1] : true;
      }
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
      deprecated: deprecated ?? doc?.deprecated,
      see: doc?.see.length ? doc.see : undefined,
      members: parsed.members.length ? parsed.members : undefined,
    });
    out.push(...parsed.nested, ...parsed.methods);
    doc = null;
    deprecated = undefined;
  }
  return out;
}

function looksLikeJavaProject(root: string): boolean {
  for (const marker of ["pom.xml", "build.gradle", "build.gradle.kts", "settings.gradle"]) {
    if (fs.existsSync(path.join(root, marker))) return true;
  }
  return walkSourceFiles(root, [".java"], { maxDepth: 6 }).length > 0;
}

export const javaAdapter: LanguageAdapter = {
  id: "java",
  detect(ctx) {
    return looksLikeJavaProject(ctx.root);
  },
  extract(ctx) {
    const files = walkSourceFiles(ctx.root, [".java"], { maxDepth: 8 }).filter(
      (f) => !/[\\/](build|target|src[\\/]test)[\\/]/.test(f) && !/(Test|Tests|IT)\.java$/.test(f),
    );
    const decls: ParsedDecl[] = [];
    for (const f of files) {
      try {
        decls.push(...parseJavaFile(fs.readFileSync(f, "utf8")));
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
