import * as fs from "node:fs";
import * as path from "node:path";
import { buildModel } from "./build.js";
import { gitShaOf } from "./git.js";
import { renderSymbolText, symbolSlug, symbolPageFrontmatter } from "./doc-text.js";
import type { RenderModel, Source } from "./types.js";

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

/**
 * Freshness stamp (Direction C): package version + git sha + build date,
 * shared by the Markdown footer so stale copies are detectable.
 */
export interface FreshnessStamp {
  version?: string;
  gitSha?: string;
  generatedAt?: string;
}

function freshnessLine(stamp: FreshnessStamp | undefined): string | null {
  if (!stamp) return null;
  const bits: string[] = [];
  if (stamp.version) bits.push(`v${stamp.version.replace(/^v/, "")}`);
  if (stamp.gitSha) bits.push(`rev ${stamp.gitSha.slice(0, 7)}`);
  if (stamp.generatedAt) bits.push(stamp.generatedAt.slice(0, 10));
  return bits.length ? `_Docs brewed by BrewDocs — ${bits.join(" · ")}._` : null;
}

/**
 * Render the DocModel to Markdown/MDX. Pure consumer of the shared text
 * pipeline (`doc-text.ts`) — the same structured data the HTML renderer
 * uses, emitted as text so it can be dropped into a wiki, README, or
 * static-site generator.
 */
export function renderToMarkdown(
  model: RenderModel,
  opts: MarkdownOptions & { freshness?: FreshnessStamp } = {},
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
    for (const sym of model.symbols) {
      out.push("", renderSymbolText(sym));
    }
  }

  const fresh = freshnessLine(opts.freshness);
  if (fresh) out.push("", "---", "", fresh);

  return out.join("\n").replace(/\n{3,}/g, "\n\n").trimEnd() + "\n";
}

/** One page of the multi-file Markdown export. */
export interface MarkdownPage {
  /** Repo-relative path inside the output dir, e.g. `symbols/brew.md`. */
  path: string;
  body: string;
}

/**
 * Per-symbol Markdown pages (Direction C) — the same shape as `--multi`
 * HTML: an index page linking to one portable, diffable page per symbol.
 * All symbol content goes through the shared `renderSymbolText` pipeline.
 */
export function renderToMarkdownMulti(
  model: RenderModel,
  opts: MarkdownOptions & { freshness?: FreshnessStamp } = {},
): MarkdownPage[] {
  const links: Record<string, string> = {};
  for (const sym of model.symbols) {
    links[sym.name] = `./symbols/${symbolSlug(sym.name)}.md`;
  }

  const pages: MarkdownPage[] = [];

  const index: string[] = [`# ${model.title}`];
  if (model.description) index.push("", model.description);
  if (model.pkg?.version) index.push("", `**Version:** ${model.pkg.version}`);
  if (model.symbols.length) {
    index.push("", "## API Reference", "");
    for (const sym of model.symbols) {
      const dep = sym.deprecated ? " ⚠️ deprecated" : "";
      const desc = sym.description ? ` — ${sym.description.split("\n")[0]}` : "";
      index.push(`- ${mdLink(sym.name, links)} _(${sym.kind})${dep}_${desc}`);
    }
  }
  const indexFresh = freshnessLine(opts.freshness);
  if (indexFresh) index.push("", "---", "", indexFresh);
  pages.push({ path: "index.md", body: index.join("\n").replace(/\n{3,}/g, "\n\n") + "\n" });

  for (const sym of model.symbols) {
    const body: string[] = symbolPageFrontmatter(sym, model);
    body.push("");
    // Cross-page links, minus the page's own symbol (self-links excluded,
    // same convention as the --multi HTML output).
    const own = { ...links };
    delete own[sym.name];
    body.push(renderSymbolText(sym, { level: 1, links: own }));
    pages.push({
      path: `symbols/${symbolSlug(sym.name)}.md`,
      body: body.join("\n") + "\n",
    });
  }

  return pages;
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
  const md = renderToMarkdown(model, {
    ...opts,
    freshness: {
      version: model.pkg?.version,
      gitSha: gitShaOf(source.root),
      generatedAt: new Date().toISOString(),
    },
  });
  fs.mkdirSync(outDir, { recursive: true });
  const outFile = path.join(outDir, `docs.${ext}`);
  fs.writeFileSync(outFile, md, "utf8");
  return outFile;
}

/**
 * Build per-symbol Markdown pages into `outDir` (`index.md` plus one
 * `symbols/<slug>.md` per exported symbol). Returns the written paths.
 */
export function buildMarkdownMulti(
  source: Source,
  outDir: string,
  opts: MarkdownOptions = {},
): string[] {
  const model = buildModel(source);
  const pages = renderToMarkdownMulti(model, {
    ...opts,
    freshness: {
      version: model.pkg?.version,
      gitSha: gitShaOf(source.root),
      generatedAt: new Date().toISOString(),
    },
  });
  fs.mkdirSync(outDir, { recursive: true });
  const written: string[] = [];
  for (const page of pages) {
    const outFile = path.join(outDir, page.path);
    fs.mkdirSync(path.dirname(outFile), { recursive: true });
    fs.writeFileSync(outFile, page.body, "utf8");
    written.push(outFile);
  }
  return written;
}

function mdLink(name: string, links?: Record<string, string>): string {
  const href = links?.[name];
  return href ? `[\`${name}\`](${href})` : `\`${name}\``;
}
