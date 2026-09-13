import * as fs from "node:fs";
import * as path from "node:path";
import type { MemberDoc, SymbolDoc } from "../types.js";
import type { LanguageAdapter } from "../plugins.js";

/**
 * v2.5 GraphQL extractor. Static parse of `*.graphql`/`*.gql` schemas: object
 * types, interfaces, inputs, enums, scalars and unions become documentable
 * symbols; fields of the root `Query`/`Mutation`/`Subscription` types become
 * callable function symbols (args as params, field type as the return).
 * Block `"""`, line `#`, and inline `"..."` strings anchor descriptions.
 */

const ROOT_OPS = new Set(["Query", "Mutation", "Subscription"]);

function splitTopLevel(list: string, sep: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let cur = "";
  let q: string | null = null;
  for (const ch of list) {
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

function stripDescription(text: string): string {
  return text
    .split(/\r?\n/)
    .map((l) => l.replace(/^#\s?/, "").replace(/^"|"$/g, "").trim())
    .filter(Boolean)
    .join(" ");
}

function parseType(t: string): string {
  return t.replace(/[![\]]/g, "").trim() || "unknown";
}

function argsToParams(args: string): SymbolDoc["params"] {
  const out: SymbolDoc["params"] = [];
  if (!args.trim()) return out;
  for (const a of splitTopLevel(args, ",")) {
    const am = /^([A-Za-z_][\w]*)\s*:\s*(.+?)\s*(=\s*.+)?$/.exec(a.trim());
    if (am) {
      // A default value always makes an arg optional; otherwise only
      // non-null (`Type!`) args are required.
      out.push({ name: am[1], type: parseType(am[2]), optional: am[3] !== undefined || !am[2].trim().endsWith("!") });
    } else if (a.trim()) {
      out.push({ name: a.trim(), type: "unknown" });
    }
  }
  return out;
}

interface ParsedType {
  name: string;
  kind: SymbolDoc["kind"];
  description?: string;
  members: MemberDoc[];
}

function parseGraphqlFile(src: string, file: string): SymbolDoc[] {
  const lines = src.split(/\r?\n/);
  const types: ParsedType[] = [];
  const rootOps: { type: string; members: MemberDoc[] }[] = [];
  let pendingDesc: string[] = [];
  let pendingFieldDesc: string[] = [];
  let brace = 0;
  let current: ParsedType | null = null;

  const flushDesc = (arr: string[]): string | undefined =>
    arr.length ? stripDescription(arr.join("\n")) : undefined;

  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i].trim();
    if (!trimmed) continue;

    // Block string description: """ ... """
    if (trimmed.startsWith('"""')) {
      const endSame = trimmed.length > 3 && trimmed.endsWith('"""');
      const block = [trimmed.slice(3).replace(/"+$/, "")];
      if (!endSame) {
        for (i++; i < lines.length; i++) {
          if (lines[i].trim().endsWith('"""')) {
            block.push(lines[i].trim().replace(/"+$/, ""));
            break;
          }
          block.push(lines[i]);
        }
      }
      (brace === 0 ? pendingDesc : pendingFieldDesc).push(stripDescription(block.join("\n")));
      continue;
    }

    // Line comment or inline string-literal description.
    if (trimmed.startsWith("#") || (trimmed.startsWith('"') && trimmed.endsWith('"'))) {
      (brace === 0 ? pendingDesc : pendingFieldDesc).push(
        trimmed.replace(/^#\s?/, "").replace(/^"|"$/g, ""),
      );
      continue;
    }

    const m = /^(?:extend\s+)?(type|interface|input|enum|scalar|union)\s+([A-Za-z_][\w]*)\s*(.*)$/.exec(
      trimmed,
    );
    if (m && brace === 0) {
      const kind = m[1];
      const name = m[2];
      const rest = m[3];
      const desc = flushDesc(pendingDesc);
      pendingDesc = [];
      pendingFieldDesc = [];

      if (kind === "scalar" || kind === "union") {
        types.push({ name, kind: "type", description: desc, members: [] });
        continue;
      }

      if (kind === "enum") {
        if (rest.includes("{") && rest.includes("}")) {
          const inner = rest.slice(rest.indexOf("{") + 1, rest.lastIndexOf("}"));
          types.push({
            name,
            kind: "type",
            description: desc,
            members: inner
              .split(/\s+/)
              .map((v) => v.replace(/#.*/, "").trim())
              .filter(Boolean)
              .map((v) => ({ name: v, kind: "property" as const, description: "enum value" })),
          });
        } else if (!rest.includes("{")) {
          const members = rest
            .replace(/^=\s*/, "")
            .split("|")
            .map((v) => v.trim())
            .filter(Boolean)
            .map((v) => ({ name: v, kind: "property" as const, description: "enum value" }));
          types.push({ name, kind: "type", description: desc, members });
        } else {
          current = { name, kind: "type", description: desc, members: [] };
          brace = 1;
        }
        continue;
      }

      // type / interface / input (possibly with an inline or block body).
      if (rest.includes("{") && rest.includes("}")) {
        const inner = rest.slice(rest.indexOf("{") + 1, rest.lastIndexOf("}"));
        const members: MemberDoc[] = [];
        for (const fl of inner.split(/\s+/)) {
          const field = fl.replace(/#.*$/, "").trim();
          const fm = /^([A-Za-z_][\w]*)\s*(\(([^)]*)\))?\s*:\s*(.+?)\s*$/.exec(field);
          if (!fm) continue;
          const fType = parseType(fm[4]);
          members.push({
            name: fm[1],
            kind: kind === "interface" ? "method" : "property",
            signature: fm[3] ? `${fm[1]}(${fm[3]}): ${fType}` : `${fm[1]}: ${fType}`,
            type: fType,
          });
        }
        finalize(name, kind, desc, members);
        continue;
      }

      current = {
        name,
        kind: kind === "interface" ? "interface" : "class",
        description: desc,
        members: [],
      };
      brace = rest.includes("{") ? 1 : 0;
      if (brace === 0) finalizeCurrent();
      continue;
    }

    // Inside a type body: field or enum value.
    if (brace > 0 && current) {
      const f = trimmed.replace(/#.*$/, "");
      if (!f) continue;
      const fm = /^([A-Za-z_][\w]*)\s*(\(([^)]*)\))?\s*:\s*(.+?)\s*$/.exec(f);
      if (fm) {
        const fName = fm[1];
        const args = fm[3] ?? "";
        const rawType = fm[4].replace(/@.*$/, "").trim();
        const fType = parseType(rawType);
        const desc = flushDesc(pendingFieldDesc);
        pendingFieldDesc = [];
        const member: MemberDoc = {
          name: fName,
          kind: current.kind === "interface" ? "method" : "property",
          signature: args ? `${fName}(${args}): ${rawType}` : `${fName}: ${rawType}`,
          type: fType,
        };
        if (desc) member.description = desc;
        current.members.push(member);
        continue;
      }
      const em = /^([A-Za-z_][\w]*)\s*(=.+)?$/.exec(f);
      if (em && current.kind === "type") {
        const desc = flushDesc(pendingFieldDesc);
        pendingFieldDesc = [];
        current.members.push({
          name: em[1],
          kind: "property",
          description: desc ?? "enum value",
        });
        continue;
      }
    }

    // Brace tracking (definition line already `continue`d above).
    for (const ch of trimmed) {
      if (ch === "{") brace++;
      else if (ch === "}") brace--;
    }
    if (brace <= 0 && current) {
      brace = 0;
      finalizeCurrent();
    }
  }

  function finalizeCurrent(): void {
    if (!current) return;
    if (ROOT_OPS.has(current.name)) {
      rootOps.push({ type: current.name, members: current.members });
    } else {
      types.push(current);
    }
    current = null;
    pendingFieldDesc = [];
  }
  function finalize(
    name: string,
    kind: string,
    desc: string | undefined,
    members: MemberDoc[],
  ): void {
    if (ROOT_OPS.has(name)) {
      rootOps.push({ type: name, members });
    } else {
      types.push({
        name,
        kind: kind === "interface" ? "interface" : "class",
        description: desc,
        members,
      });
    }
  }

  const symbols: SymbolDoc[] = types.map((t) => ({
    name: t.name,
    kind: t.kind,
    signature: `${t.kind} ${t.name}`,
    description: t.description,
    params: [],
    returns: undefined,
    examples: [],
    sourceFile: file,
    members: t.members.length ? t.members : undefined,
  }));

  for (const op of rootOps) {
    for (const member of op.members) {
      const argMatch = /\(([^)]*)\)/.exec(member.signature ?? "");
      const params = argMatch ? argsToParams(argMatch[1]) : [];
      const retType = parseType(
        (member.type ?? (member.signature ?? "").split(":").pop() ?? "unknown"),
      );
      symbols.push({
        name: `${op.type}.${member.name}`,
        kind: "function",
        signature: `${op.type}.${member.signature ?? member.name}`,
        description: member.description,
        params,
        returns: { type: retType },
        examples: [],
        sourceFile: file,
      });
    }
  }

  return symbols.sort((a, b) => a.name.localeCompare(b.name));
}

function findGraphqlFiles(root: string): string[] {
  try {
    return fs
      .readdirSync(root)
      .filter((f) => (f.endsWith(".graphql") || f.endsWith(".gql")) && !f.endsWith(".test.graphql"));
  } catch {
    return [];
  }
}

export const graphqlAdapter: LanguageAdapter = {
  id: "graphql",
  detect(ctx) {
    return findGraphqlFiles(ctx.root).length > 0;
  },
  extract(ctx) {
    const root = path.resolve(ctx.root);
    const files = findGraphqlFiles(root);
    const seen = new Set<string>();
    const out: SymbolDoc[] = [];
    for (const f of files) {
      try {
        const syms = parseGraphqlFile(fs.readFileSync(path.join(root, f), "utf8"), f);
        for (const s of syms) {
          if (seen.has(s.name)) continue;
          seen.add(s.name);
          out.push(s);
        }
      } catch {
        /* unreadable file: skip */
      }
    }
    return out.sort((a, b) => a.name.localeCompare(b.name));
  },
};
