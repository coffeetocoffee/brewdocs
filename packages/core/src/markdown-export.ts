import * as fs from "node:fs";
import * as path from "node:path";
import { buildModel } from "./build.js";
import type { RenderModel, Source, SymbolDoc } from "./types.js";

export interface MarkdownOptions {
  /** Output dialect. Both are Markdown; `mdx` adds a YAML frontmatter block. */
  format?: "md" | "mdx";
}

const README_NAMES = [
  "README.md",
  "README.markdown",
  "readme.md",
  "README.mdx",
  "readme.mdx",
];

function readRawReadme(root: string): string | undefined {
  for (const name of README_NAMES) {
    const p = path.join(root, name);
    if (fs.existsSync(p)) {
      try {
        return fs.readFileSync(p, "utf8");
      } catch {
        /* ignore */
      }
    }
  }
  return undefined;
}

function code(lang: string, body: string): string {
  return "```" + lang + "\n" + body.replace(/\n+$/, "") + "\n```";
}

function renderSymbol(sym: SymbolDoc, indent = 0): string {
  const pad = "#".repeat(3 + indent);
  const lines: string[] = [];
  const tag = sym.deprecated ? " ⚠️ deprecated" : "";
  lines.push(`${pad} \`${sym.name}\` _(${sym.kind})${tag}_`);

  if (sym.signature) lines.push(code("ts", sym.signature));
  if (sym.deprecated) {
    const note =
      typeof sym.deprecated === "string" ? sym.deprecated : "deprecated";
    lines.push(`> ⚠️ Deprecated: ${note}`);
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
    lines.push(`**Returns**`);
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
      lines.push(`${"#".repeat(4 + indent)} \`${head}\`${mods ? ` _(${mods})_` : ""}`);
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

/**
 * Render the DocModel to Markdown/MDX. This is a pure consumer of the model —
 * the same structured data the HTML renderer uses, emitted as text so it can be
 * dropped into a wiki, README, or static-site generator.
 */
export function renderToMarkdown(
  model: RenderModel,
  opts: MarkdownOptions = {},
): string {
  const format = opts.format ?? "md";
  const out: string[] = [];

  if (format === "mdx") {
    out.push("---");
    out.push(`title: ${JSON.stringify(model.title)}`);
    if (model.description) out.push(`description: ${JSON.stringify(model.description)}`);
    out.push("---");
    out.push("");
  }

  out.push(`# ${model.title}`);
  if (model.description) out.push("", model.description);

  const pkg = model.pkg;
  if (pkg) {
    const meta: string[] = [];
    if (pkg.version) meta.push(`- **Version:** ${pkg.version}`);
    if (pkg.license) meta.push(`- **License:** ${pkg.license}`);
    if (pkg.homepage) meta.push(`- **Homepage:** ${pkg.homepage}`);
    if (pkg.repository) meta.push(`- **Repository:** ${pkg.repository}`);
    if (pkg.name) meta.push(`- **Install:** \`npm install ${pkg.name}\``);
    if (meta.length) {
      out.push("", "## Package", ...meta);
    }
  }

  const readme = model.metadata?.__readme as string | undefined;
  if (readme) {
    out.push("", "## README", "", readme.trim());
  }

  if (model.symbols.length) {
    out.push("", "## API Reference", "");
    for (const sym of model.symbols) out.push("", renderSymbol(sym));
  }

  return out.join("\n").replace(/\n{3,}/g, "\n\n").trimEnd() + "\n";
}

/**
 * Build the Markdown/MDX reference for a source into `outDir`, returning the
 * written file path (`docs.md` or `docs.mdx`). When a README file exists on
 * disk it is embedded verbatim for fidelity (the in-model README is HTML).
 */
export function buildMarkdown(
  source: Source,
  outDir: string,
  opts: MarkdownOptions = {},
): string {
  const model = buildModel(source);
  const raw = readRawReadme(source.root);
  if (raw && !model.metadata.__readme) {
    // Drop a leading H1 if it duplicates the title to avoid double headings.
    const cleaned = raw.replace(/^\s*#\s+.*\n/, "");
    model.metadata = { ...model.metadata, __readme: cleaned };
  }
  const ext = opts.format === "mdx" ? "mdx" : "md";
  const md = renderToMarkdown(model, opts);
  fs.mkdirSync(outDir, { recursive: true });
  const outFile = path.join(outDir, `docs.${ext}`);
  fs.writeFileSync(outFile, md, "utf8");
  return outFile;
}
