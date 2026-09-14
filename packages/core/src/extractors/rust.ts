import * as fs from "node:fs";
import * as path from "node:path";
import type { MemberDoc, ParamDoc, SymbolDoc } from "../types.js";
import type { LanguageAdapter } from "../plugins.js";
import { walkSourceFiles, readDeclHead } from "./walk.js";

/**
 * v3.0 Rust extractor: static analysis over `.rs` files (same no-toolchain
 * philosophy as Go — `cargo metadata` would be richer but couples builds to
 * a Rust install). Covers `///` doc comments, exported functions, inherent-
 * and trait-impl methods (`Type::method`), structs (public fields), enums
 * (variants), traits, type aliases, consts/statics and `#[deprecated]`.
 */

const PUB = "pub(?:\\([^)]*\\))?\\s+";
const FN_HEAD = "(?:const\\s+|async\\s+|unsafe\\s+|extern\\s*(?:\"[^\"]*\"\\s+)?)*";
const FN_RE = new RegExp(
  `^(?:${PUB})?${FN_HEAD}fn\\s+(\\w+)\\s*(?:<.*>)?\\s*\\((.*)\\)\\s*(?:->\\s*([^{;]+?))?\\s*(?:\\{|;)$`,
);
const IMPL_RE = /^impl(?:<[^{]*>)?\s+(?:(\w[\w:]*)\s+for\s+)?(\w[\w:]*)\s*(?:<[^{]*>)?\s*\{/;
const STRUCT_RE = new RegExp(`^(${PUB})?struct\\s+(\\w+)`);
const ENUM_RE = new RegExp(`^(${PUB})?enum\\s+(\\w+)\\s*(?:<[^{]*>)?\\s*\\{`);
const TRAIT_RE = new RegExp(`^(${PUB})?trait\\s+(\\w+)`);
const MOD_RE = /^(?:pub(?:\([^)]*\))?\s+)?mod\s+\w+\s*\{/;
const TYPE_ALIAS_RE = new RegExp(`^(${PUB})?type\\s+(\\w+)(?:<[^=]*>)?\\s*=\\s*(.+?)$`);
const CONST_RE = new RegExp(`^(${PUB})?(?:const|static(?:\\s+mut)?)\\s+([A-Z][A-Z0-9_]*)\\s*:\\s*(.+?)\\s*(?:=[^;]*)?;$`);
const FIELD_RE = /^pub\s+(?:\([^)]*\)\s+)?(\w+)\s*:\s*(.+?)\s*,?;?$/;

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

function parseRustParams(list: string): ParamDoc[] {
  const params: ParamDoc[] = [];
  for (const part of splitTopLevel(list)) {
    if (/^&?(?:mut\s+)?self\b/.test(part) || part === "Self") continue;
    const m = /^(?:mut\s+)?(\w+)\s*:\s*(.+)$/.exec(part);
    if (m) params.push({ name: m[1], type: m[2].trim() });
  }
  return params;
}

/** Fold physical lines from `start` into one logical declaration line. */
function readHead(lines: string[], start: number): { head: string; end: number } {
  return readDeclHead(lines, start, (t) => /^(\/\/|#\[)/.test(t));
}

/** Line index closing the `{` opened at/inside `start`. */
function skipBlock(lines: string[], start: number): number {
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

interface ParsedDecl {
  name: string;
  kind: SymbolDoc["kind"];
  signature?: string;
  description?: string;
  params?: ParamDoc[];
  returns?: { type?: string };
  members?: MemberDoc[];
  deprecated?: string | boolean;
}

/** fns inside impl/trait bodies; `prefix` qualifies names, `exportedOnly` gates on `pub`. */
function bodyFns(body: string[], prefix: string | null, exportedOnly: boolean): ParsedDecl[] {
  const out: ParsedDecl[] = [];
  let doc: string[] = [];
  let deprecated: string | boolean | undefined;
  for (let i = 0; i < body.length; i++) {
    const t = body[i].trim();
    const cm = /^\/\/\/\s?(.*)$/.exec(t);
    if (cm) {
      doc.push(cm[1]);
      continue;
    }
    if (!t || t.startsWith("//") || t.startsWith("}")) continue;
    if (t.startsWith("#[")) {
      const dep = /^#\[deprecated(?:\(.*?note\s*=\s*"([^"]*)".*?\))?\]/.exec(t);
      if (dep) deprecated = dep[1] || true;
      continue;
    }
    const description = doc.filter(Boolean).join(" ") || undefined;
    const deprecation = deprecated;
    doc = [];
    deprecated = undefined;
    const head = readHead(body, i);
    let j = head.end;
    if (head.head.endsWith("{")) j = skipBlock(body, head.end);
    i = j;
    const fm = FN_RE.exec(head.head);
    if (!fm) continue;
    if (exportedOnly && !head.head.startsWith("pub")) continue;
    out.push({
      name: prefix ? `${prefix}::${fm[1]}` : fm[1],
      kind: "function",
      signature: head.head.replace(/[{}]\s*$/, "").replace(/;\s*$/, "").trim(),
      description,
      params: parseRustParams(fm[2]),
      returns: fm[3] ? { type: fm[3].trim() } : undefined,
      deprecated: deprecation,
    });
  }
  return out;
}

function structFields(body: string[]): MemberDoc[] {
  const members: MemberDoc[] = [];
  let doc: string[] = [];
  for (const raw of body) {
    const t = raw.trim();
    const cm = /^\/\/\/\s?(.*)$/.exec(t);
    if (cm) {
      doc.push(cm[1]);
      continue;
    }
    if (!t || t.startsWith("//") || t.startsWith("#")) continue;
    const m = FIELD_RE.exec(t);
    if (m) {
      members.push({
        name: m[1],
        kind: "property",
        type: m[2].replace(/;$/, "").trim(),
        description: doc.filter(Boolean).join(" ") || undefined,
      });
    }
    doc = [];
  }
  return members;
}

function enumVariants(body: string[]): MemberDoc[] {
  const members: MemberDoc[] = [];
  let doc: string[] = [];
  for (const raw of body) {
    const t = raw.trim();
    const cm = /^\/\/\/\s?(.*)$/.exec(t);
    if (cm) {
      doc.push(cm[1]);
      continue;
    }
    if (!t || t.startsWith("//") || t.startsWith("#")) continue;
    const m = /^(\w+)\s*(?:\(([^)]*)\))?/.exec(t);
    if (m && /^[A-Z]/.test(m[1])) {
      members.push({
        name: m[1],
        kind: "property",
        type: m[2] || undefined,
        description: doc.filter(Boolean).join(" ") || undefined,
      });
    }
    doc = [];
  }
  return members;
}

function isExported(text: string): boolean {
  return new RegExp(`^${PUB}`).test(text);
}

function parseRustSource(src: string): ParsedDecl[] {
  const out: ParsedDecl[] = [];
  const lines = src.split(/\r?\n/);
  let doc: string[] = [];
  let deprecated: string | boolean | undefined;
  let hidden = false;

  for (let i = 0; i < lines.length; i++) {
    const t = lines[i].trim();
    const cm = /^\/\/\/\s?(.*)$/.exec(t);
    if (cm) {
      doc.push(cm[1]);
      continue;
    }
    if (!t || t.startsWith("//")) continue;
    if (t.startsWith("#[")) {
      const dep = /^#\[deprecated(?:\(.*?note\s*=\s*"([^"]*)".*?\))?\]/.exec(t);
      if (dep) deprecated = dep[1] || true;
      if (/\[doc\(hidden\)\]/.test(t)) hidden = true;
      continue;
    }
    if (t.startsWith("}")) continue;

    const description = doc.filter(Boolean).join(" ") || undefined;
    const deprecation = deprecated;
    const skip = hidden;
    doc = [];
    deprecated = undefined;
    hidden = false;

    let m = IMPL_RE.exec(t);
    if (m) {
      const end = skipBlock(lines, i);
      const body = lines.slice(i + 1, end);
      i = end;
      if (skip) continue;
      out.push(...bodyFns(body, m[1] ?? m[2], true));
      continue;
    }
    m = MOD_RE.exec(t);
    if (m) {
      const end = skipBlock(lines, i);
      const body = lines.slice(i + 1, end);
      i = end;
      for (const d of parseRustSource(body.join("\n"))) out.push(d);
      continue;
    }

    const head = readHead(lines, i);
    let j = head.end;
    if (head.head.endsWith("{")) j = skipBlock(lines, head.end);
    i = j;
    const text = head.head;
    const body =
      head.head.endsWith("{") ? lines.slice(head.end + 1, skipBlock(lines, head.end)) : [];
    if (skip) continue;

    m = STRUCT_RE.exec(text);
    if (m && isExported(text)) {
      const members = body.length ? structFields(body) : [];
      out.push({
        name: m[2],
        kind: "class",
        signature: text.endsWith("{") ? `struct ${m[2]} { … }` : text.replace(/;$/, "").trim(),
        description,
        members: members.length ? members : undefined,
        deprecated: deprecation,
      });
      continue;
    }
    m = ENUM_RE.exec(text);
    if (m && isExported(text)) {
      out.push({
        name: m[2],
        kind: "class",
        signature: `enum ${m[2]} { … }`,
        description,
        members: enumVariants(body),
        deprecated: deprecation,
      });
      continue;
    }
    m = TRAIT_RE.exec(text);
    if (m && isExported(text) && text.endsWith("{")) {
      out.push({
        name: m[2],
        kind: "interface",
        signature: `trait ${m[2]} { … }`,
        description,
        members: bodyFns(body, null, false).map((d) => ({
          name: d.name,
          kind: "method" as const,
          signature: d.signature,
          description: d.description,
        })),
        deprecated: deprecation,
      });
      continue;
    }
    m = CONST_RE.exec(text);
    if (m && isExported(text)) {
      out.push({
        name: m[2],
        kind: "constant",
        signature: `const ${m[2]}: ${m[3].replace(/;$/, "").replace(/=.*$/, "").trim()}`,
        description,
        deprecated: deprecation,
      });
      continue;
    }
    m = TYPE_ALIAS_RE.exec(text);
    if (m && isExported(text)) {
      out.push({
        name: m[2],
        kind: "type",
        signature: `type ${m[2]} = ${m[3].replace(/;$/, "").trim()}`,
        description,
        deprecated: deprecation,
      });
      continue;
    }
    m = FN_RE.exec(text);
    if (m && isExported(text)) {
      out.push({
        name: m[1],
        kind: "function",
        signature: text.replace(/[{};]\s*$/, "").trim(),
        description,
        params: parseRustParams(m[2]),
        returns: m[3] ? { type: m[3].trim() } : undefined,
        deprecated: deprecation,
      });
      continue;
    }
  }
  return out;
}

function looksLikeRustProject(root: string): boolean {
  if (fs.existsSync(path.join(root, "Cargo.toml"))) return true;
  return walkSourceFiles(root, [".rs"], { maxDepth: 3 }).length > 0;
}

export const rustAdapter: LanguageAdapter = {
  id: "rust",
  detect(ctx) {
    return looksLikeRustProject(ctx.root);
  },
  extract(ctx) {
    const files = walkSourceFiles(ctx.root, [".rs"], { maxDepth: 6 }).filter(
      (f) => !/[\\/](tests|examples|benches)[\\/]/.test(f) && !/[\\/]target[\\/]/.test(f),
    );
    const decls: ParsedDecl[] = [];
    for (const f of files) {
      try {
        decls.push(...parseRustSource(fs.readFileSync(f, "utf8")));
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
        examples: [],
        deprecated: d.deprecated,
        members: d.members?.length ? d.members : undefined,
      }));
  },
};
