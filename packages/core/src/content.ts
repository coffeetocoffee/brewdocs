import * as fs from "node:fs";
import * as path from "node:path";
import { markdownToHtml } from "./markdown.js";
import { loadConfig } from "./config.js";
import type { ContentPage, NavGroup } from "./types.js";

/**
 * v2.0 content layer: authored guide pages live in a `content/` directory
 * (configurable via `contentDir:`) and render alongside the API reference.
 * `.md` goes through the existing markdown engine; `.mdx` additionally gets
 * the MDX-lite transforms below. An optional `nav.yml` (or `nav.json`) in the
 * source root defines the sidebar; without it, pages are listed alphabetically.
 *
 * MDX-lite subset (no React dependency — honest about what it compiles):
 *   - `<Component prop="x" />` and `<Component>body</Component>` compile to
 *     `<div class="mdx" data-component="Component" data-prop="x">…</div>`,
 *     so themes/plugins can style or hydrate them.
 *   - Import/export statements (pure MDX plumbing) are stripped.
 */

/* ------------------------------------------------------------------ nav */

/** Parse `nav.yml`: `Title:` lines start groups, `  Text: link` items follow. */
export function parseNavYaml(text: string): NavGroup[] {
  const groups: NavGroup[] = [];
  let current: NavGroup | null = null;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/\s+$/, "");
    if (!line.trim() || line.trim().startsWith("#")) continue;
    const indented = /^\s/.test(line);
    const m = /^\s*([^:]+):\s*(.*)$/.exec(line);
    if (!m) continue;
    const [, key, val] = m;
    if (!indented && !val.trim()) {
      current = { title: key.trim(), items: [] };
      groups.push(current);
    } else if (indented && current) {
      current.items.push({ text: key.trim(), link: val.trim().replace(/^["']|["']$/g, "") });
    } else if (!current) {
      current = { title: "Guides", items: [] };
      groups.push(current);
      current.items.push({ text: key.trim(), link: val.trim() });
    }
  }
  return groups;
}

export function loadNav(root: string): NavGroup[] | undefined {
  for (const name of ["nav.yml", "nav.yaml", "nav.json"]) {
    const file = path.join(root, name);
    if (!fs.existsSync(file)) continue;
    try {
      const text = fs.readFileSync(file, "utf8");
      if (name.endsWith(".json")) return JSON.parse(text) as NavGroup[];
      const groups = parseNavYaml(text);
      return groups.length ? groups : undefined;
    } catch {
      return undefined;
    }
  }
  return undefined;
}

/* ------------------------------------------------------------- mdx-lite */

/** Compile JSX-ish components to styled, addressable placeholders. */
export function transformMdx(src: string): string {
  // Strip MDX import/export statements.
  let out = src.replace(/^\s*import\s+[^\n]+$/gm, "").replace(/^\s*export\s+(const|default)\s[^\n]*=?\s*$/gm, "");

  // Self-closing components.
  out = out.replace(/<([A-Z][\w.]*)((?:\s+[\w-]+=(?:"[^"]*"|\{[^}]*\}))*?)\s*\/>/g, (_m, tag, props) =>
    `<div class="mdx" data-component="${tag}"${compileProps(props)}></div>`,
  );

  // Paired components (non-greedy, one nesting level is enough for docs).
  out = out.replace(
    /<([A-Z][\w.]*)((?:\s+[\w-]+=(?:"[^"]*"|\{[^}]*\}))*?)>((?:(?!<\/?\1>)[\s\S])*)<\/\1>/g,
    (_m, tag, props, body) =>
      `<div class="mdx" data-component="${tag}"${compileProps(props)}>${body.trim()}</div>`,
  );

  return out;
}

function compileProps(props: string): string {
  const out: string[] = [];
  for (const m of props.matchAll(/([\w-]+)=("|')(.*?)\2/g)) {
    out.push(` data-${m[1].toLowerCase()}="${m[3].replace(/"/g, "&quot;")}"`);
  }
  for (const m of props.matchAll(/([\w-]+)=\{([^}]*)\}/g)) {
    out.push(` data-${m[1].toLowerCase()}-expr="${m[2].trim().replace(/"/g, "&quot;")}"`);
  }
  return out.join("");
}

/* -------------------------------------------------------------- loading */

function parseFrontmatter(src: string): { meta: Record<string, string>; body: string } {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(src);
  if (!m) return { meta: {}, body: src };
  const meta: Record<string, string> = {};
  for (const line of m[1].split(/\r?\n/)) {
    const kv = /^([\w-]+):\s*(.*)$/.exec(line);
    if (kv) meta[kv[1]] = kv[2].trim().replace(/^["']|["']$/g, "");
  }
  return { meta, body: src.slice(m[0].length) };
}

function slugify(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function walkContent(dir: string, base: string, files: string[]): void {
  let items: fs.Dirent[];
  try {
    items = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const item of items.sort((a, b) => a.name.localeCompare(b.name))) {
    if (item.name.startsWith(".") || item.name === "node_modules") continue;
    const abs = path.join(dir, item.name);
    if (item.isDirectory()) walkContent(abs, base, files);
    else if (/\.(md|mdx|markdown)$/i.test(item.name)) files.push(abs);
  }
}

/** Render one content source string to {html, headings, title, description}. */
export function renderContentSource(src: string, isMdx: boolean): {
  html: string;
  headings: { id: string; title: string }[];
  meta: Record<string, string>;
} {
  const { meta, body } = parseFrontmatter(src);
  const md = isMdx ? transformMdx(body) : body;
  const html = markdownToHtml(md);
  const headings: { id: string; title: string }[] = [];
  for (const m of html.matchAll(/<h([23])>([^<]+)<\/h\1>/g)) {
    headings.push({ id: slugify(m[2]), title: m[2] });
  }
  return { html, headings, meta };
}

/** Discover and compile all guide pages under `<root>/<contentDir>`. */
export function loadContent(root: string): ContentPage[] {
  const dirName = loadConfig(root).contentDir ?? "content";
  const dir = path.join(root, dirName);
  if (!fs.existsSync(dir)) return [];
  const files: string[] = [];
  walkContent(dir, dir, files);
  const pages: ContentPage[] = [];
  for (const file of files) {
    let src: string;
    try {
      src = fs.readFileSync(file, "utf8");
    } catch {
      continue;
    }
    const isMdx = /\.mdx$/i.test(file);
    const { html, headings, meta } = renderContentSource(src, isMdx);
    const rel = path.relative(dir, file).replace(/\\/g, "/");
    const slug = meta.slug ?? rel.replace(/\.(md|mdx|markdown)$/i, "").replace(/\/index$/, "");
    const fallbackTitle = path.basename(file).replace(/\.(md|mdx|markdown)$/i, "");
    pages.push({
      slug,
      path: `${dirName}/${slug}.html`,
      title: meta.title ?? headings[0]?.title ?? fallbackTitle,
      description: meta.description,
      order: meta.order ? Number(meta.order) || undefined : undefined,
      html,
      headings,
    });
  }
  pages.sort((a, b) => {
    if (a.order !== undefined || b.order !== undefined) {
      if ((a.order ?? Infinity) !== (b.order ?? Infinity)) {
        return (a.order ?? Infinity) - (b.order ?? Infinity);
      }
    }
    return a.slug.localeCompare(b.slug);
  });
  return pages;
}
