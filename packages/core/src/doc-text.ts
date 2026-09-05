import type { RenderModel, SymbolDoc } from "./types.js";
import { replacementHint } from "./replacements.js";

/**
 * Single text-rendering pipeline (Direction C). Every Markdown surface —
 * the full docs.md reference and the per-symbol pages — renders through
 * these shared primitives, so the formats can't drift apart as the
 * DocModel evolves. JSON/HTML stay separate renderers; the contract here is
 * the symbol/section *text*.
 */

export interface SymbolTextOptions {
  /** Heading level for the symbol itself (default 3 => `###`). */
  level?: number;
  /** Heading level offset for member blocks (default 0). */
  memberOffset?: number;
  /** Cross-page links: symbol name -> relative Markdown path. */
  links?: Record<string, string>;
}

function code(lang: string, body: string): string {
  return "```" + lang + "\n" + body.replace(/\n+$/, "") + "\n```";
}

function mdLink(name: string, links?: Record<string, string>): string {
  const href = links?.[name];
  return href ? `[\`${name}\`](${href})` : `\`${name}\``;
}

/**
 * Render one symbol (and its members) as Markdown. The one true symbol
 * renderer — docs.md and symbols/*.md both go through here.
 */
export function renderSymbolText(
  sym: SymbolDoc,
  opts: SymbolTextOptions = {},
): string {
  const level = opts.level ?? 3;
  const pad = "#".repeat(level);
  const lines: string[] = [];
  const tag = sym.deprecated ? " ⚠️ deprecated" : "";
  lines.push(`${pad} ${mdLink(sym.name, opts.links)} _(${sym.kind})${tag}_`);

  if (sym.signature) lines.push(code("ts", sym.signature));
  if (sym.deprecated) {
    const note =
      typeof sym.deprecated === "string" ? sym.deprecated : "deprecated";
    // Skip the resolved hint when the note already names every successor.
    const hint = replacementHint(sym.replacements);
    const noteText = typeof sym.deprecated === "string" ? sym.deprecated : "";
    const redundant = (sym.replacements ?? []).every((r) =>
      noteText.includes(r),
    );
    lines.push(
      `> ⚠️ Deprecated: ${note}${hint && !redundant ? ` — ${hint}` : ""}`,
    );
  }
  if (sym.description) lines.push(sym.description.trim());

  if (sym.typeParams && sym.typeParams.length) {
    lines.push("**Type Parameters**");
    for (const t of sym.typeParams) {
      const bits = [`\`${t.name}\``];
      if (t.constraint) bits.push(`_${t.constraint}_`);
      if (t.default) bits.push(`= \`${t.default}\``);
      lines.push(`- ${bits.join(" ")}`);
    }
  }

  if (sym.params.length) {
    lines.push("**Parameters**");
    for (const p of sym.params) {
      const bits = [`\`${p.name}\``];
      if (p.type) bits.push(`_${p.type}_`);
      let line = `- ${bits.join(" ")}`;
      if (p.optional) line += " _(optional)_";
      if (p.description) line += ` — ${p.description}`;
      if (p.default) line += ` (default: \`${p.default}\`)`;
      lines.push(line);
    }
  }

  if (sym.returns) {
    const r = `_${sym.returns.type ?? "void"}_`;
    lines.push("**Returns**");
    lines.push(
      sym.returns.description ? `${r} — ${sym.returns.description}` : r,
    );
  }

  if (sym.throws && sym.throws.length) {
    lines.push("**Throws**");
    for (const t of sym.throws) lines.push(`- ${t}`);
  }

  if (sym.see && sym.see.length) {
    lines.push("**See**");
    for (const s of sym.see) lines.push(`- ${s}`);
  }

  if (sym.members && sym.members.length) {
    lines.push("**Members**");
    for (const m of sym.members) {
      const mods = [
        m.static ? "static" : "",
        m.readonly ? "readonly" : "",
        m.visibility ?? "",
      ]
        .filter(Boolean)
        .join(" ");
      const head = m.signature ?? (m.type ? `${m.name}: ${m.type}` : m.name);
      lines.push(
        `${"#".repeat(level + 1 + (opts.memberOffset ?? 0))} \`${head}\`${mods ? ` _(${mods})_` : ""}`,
      );
      if (typeof m.deprecated === "string") {
        lines.push(`> ⚠️ Deprecated: ${m.deprecated}`);
      }
      if (m.description) lines.push(m.description.trim());
    }
  }

  if (sym.examples.length) {
    lines.push("**Examples**");
    for (const ex of sym.examples) lines.push(code("ts", ex));
  }

  return lines.join("\n");
}

/** Slug for a per-symbol Markdown file name (no extension). */
export function symbolSlug(name: string): string {
  return (
    name
      .toLowerCase()
      .replace(/^@/, "")
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "") || "symbol"
  );
}

/** Frontmatter block for a per-symbol page. */
export function symbolPageFrontmatter(
  sym: SymbolDoc,
  model: RenderModel,
): string[] {
  const lines = ["---", `title: ${JSON.stringify(sym.name)}`];
  if (model.pkg?.name) lines.push(`package: ${JSON.stringify(model.pkg.name)}`);
  if (model.pkg?.version)
    lines.push(`version: ${JSON.stringify(model.pkg.version)}`);
  if (sym.deprecated) lines.push("deprecated: true");
  lines.push("---");
  return lines;
}
