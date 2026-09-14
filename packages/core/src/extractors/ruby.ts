import * as fs from "node:fs";
import * as path from "node:path";
import type { MemberDoc, ParamDoc, SymbolDoc } from "../types.js";
import type { LanguageAdapter } from "../plugins.js";
import { walkSourceFiles } from "./walk.js";

/**
 * v3.0 Ruby extractor: static analysis of `.rb` sources (YARD-flavoured
 * comments). Top-level `def`s become function symbols; methods inside
 * classes/modules become `Klass#inst` / `Klass.singleton` functions; classes
 * and modules are emitted with `attr_*` accessors as members. Visibility
 * (`private`/`protected`) and `=begin/=end` doc blocks are honoured.
 */

interface YardDoc {
  description?: string;
  params: Map<string, { type?: string; description?: string }>;
  returns?: { type?: string; description?: string };
  throws: string[];
  deprecated?: string | boolean;
  see: string[];
}

function parseYard(lines: string[]): YardDoc {
  const doc: YardDoc = { params: new Map(), throws: [], see: [] };
  const desc: string[] = [];
  for (const raw of lines) {
    const t = raw.replace(/^\s*#+\s?/, "").trim();
    if (!t) continue;
    let m = /^@param\s+(\S+)(?:\s+\[([^\]]*)\])?\s*(.*)$/.exec(t);
    if (m) {
      doc.params.set(m[1], { type: m[2]?.trim() || undefined, description: m[3].trim() || undefined });
      continue;
    }
    m = /^@return(?:s)?\s*(?:\[([^\]]*)\])?\s*(.*)$/.exec(t);
    if (m) {
      doc.returns = { type: m[1]?.trim() || undefined, description: m[2].trim() || undefined };
      continue;
    }
    m = /^@raise\s+(\S+)\s*(.*)$/.exec(t);
    if (m) {
      const type = m[1].replace(/[\[\]]/g, "");
      doc.throws.push(m[2] ? `${type} — ${m[2]}` : type);
      continue;
    }
    m = /^@deprecated\s*(.*)$/.exec(t);
    if (m) {
      doc.deprecated = m[1].trim() || true;
      continue;
    }
    m = /^@see\s+(.*)$/.exec(t);
    if (m) {
      doc.see.push(m[1].trim());
      continue;
    }
    if (/^@/.test(t)) continue; // other tags (example, api, …) don't count as prose
    desc.push(t);
  }
  doc.description = desc.join(" ") || undefined;
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

function parseRubyParams(list: string, doc: YardDoc | null): ParamDoc[] {
  const params: ParamDoc[] = [];
  for (const part of splitTopLevel(list)) {
    if (!part) continue;
    let m = /^(\w+):\s*(.*)$/.exec(part); // keyword arg (with or without default)
    if (m) {
      const yd = doc?.params.get(`${m[1]}:`);
      params.push({
        name: `${m[1]}:`,
        type: yd?.type,
        description: yd?.description,
        optional: Boolean(m[2].trim()) || undefined,
        default: m[2].trim() || undefined,
      });
      continue;
    }
    m = /^\*\*(\w+)$/.exec(part);
    if (m) {
      params.push({ name: `**${m[1]}`, optional: true });
      continue;
    }
    m = /^\*(\w+)$/.exec(part);
    if (m) {
      params.push({ name: `*${m[1]}`, optional: true });
      continue;
    }
    if (/^&/.test(part)) continue;
    m = /^(\w+)\s*=\s*(.+)$/.exec(part);
    if (m) {
      const yd = doc?.params.get(m[1]);
      params.push({
        name: m[1],
        type: yd?.type,
        description: yd?.description,
        optional: true,
        default: m[2].trim(),
      });
      continue;
    }
    m = /^(\w+)$/.exec(part);
    if (m) {
      const yd = doc?.params.get(m[1]);
      params.push({ name: m[1], type: yd?.type, description: yd?.description });
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
  returns?: { type?: string; description?: string };
  throws?: string[];
  see?: string[];
  members?: MemberDoc[];
  deprecated?: string | boolean;
}

/** Index of the `end` closing the block that opens on line `start`. */
function findEnd(lines: string[], start: number): number {
  let depth = 0;
  for (let i = start; i < lines.length; i++) {
    const t = lines[i].trim();
    if (/^(#|=begin\b)/.test(t) && i !== start) {
      if (t.startsWith("#")) continue;
    }
    // one opener per leading keyword-ish line; `do` blocks too
    if (i === start) depth++;
    else {
      if (/^(if|unless|case|while|until|for|begin)\b/.test(t) && !/;\s*end\b/.test(t)) depth++;
      else if (/\bdo(\s+\|[^|]*\|)?\s*$/.test(t)) depth++;
      else if (/^end\b/.test(t)) {
        depth--;
        if (depth === 0) return i;
      }
    }
  }
  return lines.length - 1;
}

function parseRubyFile(src: string, file: string): ParsedDecl[] {
  const out: ParsedDecl[] = [];
  const lines = src.split(/\r?\n/);
  const stack: { name: string; members: MemberDoc[] }[] = [];
  let docLines: string[] = [];
  let visibility: "public" | "private" | "protected" = "public";
  let blockDepth = 0;
  let inRawDoc = false;

  const qualified = (name: string) =>
    stack.length ? [...stack.map((s) => s.name), name].join("::") : name;
  const currentMembers = () => (stack.length ? stack[stack.length - 1].members : null);

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    let t = raw.trim();

    if (inRawDoc) {
      if (/^=end\b/.test(t)) inRawDoc = false;
      else docLines.push(t);
      continue;
    }
    if (/^=begin\b/.test(t)) {
      inRawDoc = true;
      continue;
    }
    if (t.startsWith("#!")) continue;
    if (t.startsWith("#")) {
      docLines.push(t);
      continue;
    }
    if (!t) {
      continue; // blank lines keep the doc buffer (comment-then-blank-then-def happens)
    }

    const doc = docLines.length ? parseYard(docLines) : null;
    docLines = [];

    let m = /^module\s+([\w:]+)\b/.exec(t);
    if (m && !/;\s*$/.test(t)) {
      const members: MemberDoc[] = [];
      out.push({
        name: qualified(m[1]),
        kind: "class",
        signature: t,
        description: doc?.description,
        members,
      });
      stack.push({ name: qualified(m[1]), members });
      visibility = "public";
      continue;
    }
    m = /^class\s+(<<\s*\S+|[\w:]+)\b/.exec(t);
    if (m && !/;\s*$/.test(t)) {
      const singletonClass = m[1].startsWith("<<");
      const members: MemberDoc[] = [];
      if (!singletonClass) {
        out.push({
          name: qualified(m[1]),
          kind: "class",
          signature: t,
          description: doc?.description,
          deprecated: doc?.deprecated,
          members,
        });
      }
      // always push so the matching `end` never pops an outer scope
      stack.push({ name: singletonClass ? "" : qualified(m[1]), members });
      visibility = "public";
      continue;
    }
    if (/^end\b/.test(t)) {
      if (blockDepth > 0) {
        blockDepth--;
      } else {
        stack.pop();
        visibility = "public";
      }
      continue;
    }
    if (/^(if|unless|case|while|until|for|begin)\b/.test(t) && !/;\s*end\s*$/.test(t)) {
      blockDepth++;
      continue;
    }
    m = /^(private|protected|public)(?:\s+class_method\s+:(\w+)|\s+method\s+:(\w+))?\s*$/.exec(t);
    if (m) {
      const named = m[2] ?? m[3];
      if (named && currentMembers()) {
        const target = currentMembers()!.find((x) => x.name === named);
        if (target) target.visibility = "private";
      } else if (m[1] !== "public") {
        visibility = m[1] as "private" | "protected";
      }
      continue;
    }
    m = /^(?:private|protected)\s+(def\s+.*)$/.exec(t);
    if (m) {
      t = m[1];
      visibility = "private";
    }
    m = /^attr_(accessor|reader|writer)\s+(.*)$/.exec(t);
    if (m && currentMembers() && visibility === "public") {
      for (const sym of m[2].split(",")) {
        const name = /:(\w+[=!?]?)/.exec(sym)?.[1];
        if (name) {
          currentMembers()!.push({
            name: m[1] === "writer" ? `${name}=` : name,
            kind: "property",
            readonly: m[1] === "reader" || undefined,
            description: doc?.description,
          });
        }
      }
      continue;
    }
    m = /^def\s+((?:self\.)?[\w:]+[.!?]?[\w=+\-*/%<>~\[\]]*|[<>=!~+\-*/%\[\]]+|==|!=|<=|>=|<=>|!|\[\]=?)\s*(?:\(([^)]*)\)|([a-z_]\w*(?:\s*,\s*[a-z_]\w*)*))?\s*(=[^;]*)?$/.exec(t);
    if (m && !/^def\s*$/.test(t)) {
      const rawName = m[1];
      const singleton = rawName.startsWith("self.");
      const name = singleton ? rawName.slice(5) : rawName;
      const paramsRaw = m[2] ?? m[3] ?? "";
      const endless = Boolean(m[4]);
      const owner = stack.length && stack[stack.length - 1].name
        ? stack[stack.length - 1].name
        : null;
      const full = owner ? `${owner}${singleton ? "." : "#"}${name}` : name;
      const params = parseRubyParams(paramsRaw, doc);
      if (name === "initialize") {
        if (owner && currentMembers()) {
          currentMembers()!.push({
            name: owner.split("::").pop()!,
            kind: "constructor",
            signature: `def initialize(${paramsRaw})`.replace(/,+\s*$/, ""),
            description: doc?.description,
          });
        }
        if (!endless) i = findEnd(lines, i);
        continue;
      }
      if (!owner || visibility === "public") {
        out.push({
          name: full,
          kind: "function",
          signature: `def ${singleton ? "self." : ""}${name}${paramsRaw ? `(${paramsRaw})` : ""}`,
          description: doc?.description,
          params,
          returns: doc?.returns,
          throws: doc?.throws.length ? doc.throws : undefined,
          see: doc?.see.length ? doc.see : undefined,
          deprecated: doc?.deprecated,
        });
      }
      if (!endless) i = findEnd(lines, i);
      continue;
    }
    m = /^([A-Z][A-Z0-9_]*)\s*=(?!=)\s*(.+)$/.exec(t);
    if (m) {
      out.push({
        name: qualified(m[1]),
        kind: "constant",
        signature: `${m[1]} = ${m[2].replace(/\s*#.*$/, "").trim()}`,
        description: doc?.description,
      });
      continue;
    }
  }
  void file;
  return out;
}

function looksLikeRubyProject(root: string): boolean {
  try {
    const entries = fs.readdirSync(root, { withFileTypes: true }).map((e) => e.name);
    if (entries.some((n) => n.endsWith(".gemspec"))) return true;
    if (entries.includes("Gemfile") && walkSourceFiles(root, [".rb"], { maxDepth: 3 }).length) {
      return true;
    }
  } catch {
    return false;
  }
  return walkSourceFiles(root, [".rb"], { maxDepth: 4 }).length > 0;
}

export const rubyAdapter: LanguageAdapter = {
  id: "ruby",
  detect(ctx) {
    return looksLikeRubyProject(ctx.root);
  },
  extract(ctx) {
    const files = walkSourceFiles(ctx.root, [".rb"], { maxDepth: 6 }).filter(
      (f) => !/[\\/](spec|test|vendor)[\\/]/.test(f) && !/_spec\.rb$/.test(f) && !/_test\.rb$/.test(f),
    );
    const decls: ParsedDecl[] = [];
    for (const f of files) {
      try {
        decls.push(...parseRubyFile(fs.readFileSync(f, "utf8"), path.basename(f)));
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
