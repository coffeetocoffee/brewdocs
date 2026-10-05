import * as fs from "node:fs";
import * as path from "node:path";
import { createHash } from "node:crypto";
import { escapeHtml } from "./escape.js";

/**
 * v3.0 plugin registry + marketplace (local control-plane, same spirit as
 * cloud.ts/domains.ts): a JSON store `<registryDir>/.registry.json` plus
 * versioned entry files under `<registryDir>/packages/`. `brewdocs registry
 * publish|search|install` feeds `plugins:` resolution — a plugin spec that
 * isn't a path or an npm package is looked up in the registry (config
 * `registry:` or BREWDOCS_REGISTRY). `registry gallery` renders a static
 * marketplace page. No network, no execution at publish time (entries are
 * stored and only ever loaded by the normal plugin loader later).
 */

export interface RegistryEntry {
  name: string;
  version: string;
  /** Stored entry file, relative to the registry dir. */
  entry: string;
  /** sha256 of the stored module (tamper evidence; recorded at publish). */
  integrity?: string;
  kind: "plugin" | "adapter" | "theme";
  description?: string;
  author?: string;
  keywords?: string[];
  publishedAt: string;
  installs: number;
  /** Full publish history (name@version, newest last). */
  versions?: { version: string; publishedAt: string }[];
}

/** On-disk shape of `.registry.json` — every published plugin entry. */
export interface RegistryStore {
  plugins: RegistryEntry[];
}

const REGISTRY_FILE = ".registry.json";

function storeFile(dir: string): string {
  return path.join(dir, REGISTRY_FILE);
}

/** sha256 of an entry file's bytes, `sha256:<hex>` — tamper evidence, not signing. */
function integrityOf(file: string): string {
  return "sha256:" + createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

/**
 * Load the plugin registry from `<registryDir>/.registry.json`.
 *
 * @param registryDir - directory holding the registry store.
 * @returns the parsed store, or an empty store when the file is missing or malformed.
 */
export function loadRegistry(registryDir: string): RegistryStore {
  try {
    const raw = JSON.parse(fs.readFileSync(storeFile(registryDir), "utf8")) as RegistryStore;
    if (raw && Array.isArray(raw.plugins)) return raw;
  } catch {
    /* fresh store */
  }
  return { plugins: [] };
}

function saveRegistry(registryDir: string, store: RegistryStore): void {
  fs.mkdirSync(registryDir, { recursive: true });
  fs.writeFileSync(storeFile(registryDir), JSON.stringify(store, null, 2), "utf8");
}

/**
 * Slugify a plugin name into its registry key.
 *
 * @param name - plugin name (may include an npm scope like `@org/pkg`).
 * @returns the lowercased slug with scopes and slashes flattened to dashes.
 */
export function slug(name: string): string {
  return name
    .toLowerCase()
    .replace(/^@/, "")
    .replace(/\//g, "-")
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function semverLt(a: string, b: string): boolean {
  const pa = a.split(".").map(Number);
  const pb = b.split(".").map(Number);
  for (let i = 0; i < 3; i++) {
    const x = pa[i] || 0;
    const y = pb[i] || 0;
    if (x !== y) return x < y;
  }
  return false;
}

/**
 * Reject a module that can't possibly be a BrewDocs plugin before storing
 * it (publish must not accept random binaries). Static text check only —
 * nothing is executed at publish time.
 */
function looksLikePluginModule(source: string): boolean {
  return (
    /definePlugin|defineAdapter|module\.exports|exports\.|"name"\s*:|adapters\s*:|onExtract|onRender|theme\s*:/.test(
      source,
    ) ||
    /export\s+(?:default\s+)/.test(source)
  );
}

/** Metadata recorded at publish time: version, description, entry file. */
export interface PublishOptions {
  name: string;
  version: string;
  kind?: RegistryEntry["kind"];
  description?: string;
  author?: string;
  keywords?: string[];
}

/**
 * Publish a plugin module file; republish needs a newer version.
 *
 * @param registryDir - directory holding the registry store.
 * @param modulePath - path to the plugin module file to store.
 * @param opts - publish metadata: name, version, kind, description, author, keywords.
 * @returns the stored registry entry, or null when rejected (bad name/version, unreadable or non-plugin file, or version not newer).
 */
export function publishPlugin(
  registryDir: string,
  modulePath: string,
  opts: PublishOptions,
): RegistryEntry | null {
  const name = slug(opts.name);
  const version = String(opts.version ?? "").trim();
  if (!name || !/^\d+(\.\d+){0,2}([-.\w]*)?$/.test(version)) {
    console.warn(`[brewdocs] publish rejected: name "${opts.name}" or version "${opts.version}" invalid`);
    return null;
  }
  let source: string;
  try {
    source = fs.readFileSync(modulePath, "utf8");
  } catch {
    console.warn(`[brewdocs] publish rejected: cannot read ${modulePath}`);
    return null;
  }
  if (!looksLikePluginModule(source)) {
    console.warn(`[brewdocs] publish rejected: ${modulePath} doesn't look like a plugin module`);
    return null;
  }
  const store = loadRegistry(registryDir);
  const existing = store.plugins.find((p) => p.name === name);
  if (existing && !semverLt(existing.version, version)) {
    console.warn(
      `[brewdocs] publish rejected: ${name}@${version} ≤ published ${existing.version} (bump the version)`,
    );
    return null;
  }
  const ext = path.extname(modulePath) || ".cjs";
  const relEntry = path.posix.join("packages", `${name}@${version}${ext}`);
  const absEntry = path.join(registryDir, ...relEntry.split("/"));
  fs.mkdirSync(path.dirname(absEntry), { recursive: true });
  fs.copyFileSync(modulePath, absEntry);
  const record: RegistryEntry = {
    name,
    version,
    entry: relEntry,
    integrity: integrityOf(absEntry),
    kind: opts.kind ?? "plugin",
    description: opts.description,
    author: opts.author,
    keywords: opts.keywords,
    publishedAt: new Date().toISOString(),
    installs: existing?.installs ?? 0,
    versions: [...(existing?.versions ?? []), { version, publishedAt: new Date().toISOString() }],
  };
  if (existing) Object.assign(existing, record);
  else store.plugins.push(record);
  saveRegistry(registryDir, store);
  return record;
}

/**
 * List every plugin published to the registry.
 *
 * @param registryDir - directory holding the registry store.
 * @returns entries sorted by name.
 */
export function listPlugins(registryDir: string): RegistryEntry[] {
  return loadRegistry(registryDir).plugins.slice().sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Look up a single registry entry by name.
 *
 * @param registryDir - directory holding the registry store.
 * @param name - plugin name to find (slugged before lookup).
 * @returns the registry entry, or undefined when no plugin matches.
 */
export function getPlugin(registryDir: string, name: string): RegistryEntry | undefined {
  const s = slug(name);
  return loadRegistry(registryDir).plugins.find((p) => p.name === s);
}

/**
 * Search registry entries by name, description, keywords or kind.
 *
 * @param registryDir - directory holding the registry store.
 * @param query - case-insensitive substring (empty returns every plugin).
 * @returns the matching registry entries.
 */
export function searchPlugins(registryDir: string, query: string): RegistryEntry[] {
  const q = query.toLowerCase().trim();
  if (!q) return listPlugins(registryDir);
  return listPlugins(registryDir).filter((p) =>
    [p.name, p.description ?? "", p.keywords?.join(" ") ?? "", p.kind]
      .join(" ")
      .toLowerCase()
      .includes(q),
  );
}

/**
 * Remove a plugin from the registry.
 *
 * @param registryDir - directory holding the registry store.
 * @param name - plugin name to remove (slugged before lookup).
 * @returns true when an entry was removed, false when no plugin matched.
 */
export function unpublishPlugin(registryDir: string, name: string): boolean {
  const store = loadRegistry(registryDir);
  const s = slug(name);
  const before = store.plugins.length;
  store.plugins = store.plugins.filter((p) => p.name !== s);
  if (store.plugins.length === before) return false;
  saveRegistry(registryDir, store);
  return true;
}

/**
 * Copy a registry entry into `<targetRoot>/.brewdocs/plugins/<slug>.cjs` and
 * return the relative spec `loadPlugins` understands. Increments installs.
 *
 * Returns null on any refusal; pass `out` to learn why (the CLI reports the
 * true cause instead of always claiming the plugin does not exist).
 *
 * @param registryDir - directory holding the registry store.
 * @param name - plugin name to install.
 * @param targetRoot - project root that receives `.brewdocs/plugins/<slug>.cjs`.
 * @param out - optional object set with a `reason` when the install is refused.
 * @returns the relative plugin spec and entry, or null on refusal.
 */
export function installPlugin(
  registryDir: string,
  name: string,
  targetRoot: string,
  out?: { reason?: "not-found" | "missing-file" | "integrity" },
): { spec: string; entry: RegistryEntry } | null {
  const entry = getPlugin(registryDir, name);
  if (!entry) {
    if (out) out.reason = "not-found";
    return null;
  }
  const src = path.join(registryDir, ...entry.entry.split("/"));
  if (!fs.existsSync(src)) {
    if (out) out.reason = "missing-file";
    console.warn(`[brewdocs] registry entry file missing: ${src}`);
    return null;
  }
  // A recorded hash that no longer matches means the stored module changed
  // after publish; refuse to install it. Entries published before integrity
  // existed carry none and are still allowed (with a warning via verify).
  if (entry.integrity && integrityOf(src) !== entry.integrity) {
    if (out) out.reason = "integrity";
    console.warn(
      `[brewdocs] registry integrity mismatch for ${entry.name}@${entry.version} — refusing install (run \`brewdocs registry verify\`)`,
    );
    return null;
  }
  const pluginsDir = path.join(targetRoot, ".brewdocs", "plugins");
  fs.mkdirSync(pluginsDir, { recursive: true });
  const dest = path.join(pluginsDir, `${entry.name}.cjs`);
  fs.copyFileSync(src, dest);
  const store = loadRegistry(registryDir);
  const rec = store.plugins.find((p) => p.name === entry.name);
  if (rec) {
    rec.installs++;
    saveRegistry(registryDir, store);
  }
  return { spec: `./.brewdocs/plugins/${entry.name}.cjs`, entry };
}

/**
 * Absolute path of a registry entry's module, or null (used by loadPlugin).
 *
 * @param registryDir - directory holding the registry store.
 * @param name - plugin name to resolve.
 * @returns the absolute entry module path, or null when missing or failing integrity.
 */
export function registryEntryPath(registryDir: string, name: string): string | null {
  const entry = getPlugin(registryDir, name);
  if (!entry) return null;
  const abs = path.join(registryDir, ...entry.entry.split("/"));
  if (!fs.existsSync(abs)) return null;
  if (entry.integrity && integrityOf(abs) !== entry.integrity) {
    console.warn(`[brewdocs] registry integrity mismatch for ${entry.name} — refusing to load`);
    return null;
  }
  return abs;
}

/** Per-entry integrity check outcome (ok / mismatch / missing-file / unsigned). */
export interface RegistryVerifyResult {
  name: string;
  version: string;
  status: "ok" | "mismatch" | "missing-file" | "unsigned";
}

/**
 * Recompute every entry's recorded hash. `unsigned` = published before
 * integrity was recorded (allowed to install, but re-publish to add it).
 *
 * @param registryDir - directory holding the registry store.
 * @returns a per-entry verification status (ok, mismatch, missing-file or unsigned).
 */
export function verifyRegistry(registryDir: string): RegistryVerifyResult[] {
  return listPlugins(registryDir).map((p) => {
    const abs = path.join(registryDir, ...p.entry.split("/"));
    if (!fs.existsSync(abs)) return { name: p.name, version: p.version, status: "missing-file" };
    if (!p.integrity) return { name: p.name, version: p.version, status: "unsigned" };
    return {
      name: p.name,
      version: p.version,
      status: integrityOf(abs) === p.integrity ? "ok" : "mismatch",
    };
  });
}

/**
 * Static marketplace gallery of the registry (standalone HTML, theme-free
 * like gallery.ts). Returns the written index.html path.
 *
 * @param registryDir - directory holding the registry store.
 * @param outDir - directory the marketplace page is written into.
 * @returns the path of the generated index.html.
 */
export function buildRegistryGallery(registryDir: string, outDir: string): string {
  const entries = listPlugins(registryDir);
  const cards = entries
    .map(
      (p) => `<li class="card">
  <div class="row"><a class="p-name">${escapeHtml(p.name)}</a><span class="p-kind k-${escapeHtml(p.kind)}">${escapeHtml(p.kind)}</span></div>
  <p class="p-desc">${escapeHtml(p.description ?? "no description")}</p>
  <div class="p-meta">v${escapeHtml(p.version)} · ${p.installs} install(s)${p.author ? ` · by ${escapeHtml(p.author)}` : ""}</div>
  <code class="p-use">brewdocs registry install ${escapeHtml(p.name)}</code>
</li>`,
    )
    .join("\n");
  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<meta name="description" content="BrewDocs plugin registry — adapters, hooks and themes." />
<meta name="generator" content="brewdocs" />
<title>BrewDocs Marketplace</title>
<style>
  :root { --bg:#fbf7f0; --ink:#2b2118; --muted:#7a6a58; --accent:#b5651d; --card:#fffdf9; --line:#e7ddd0; }
  * { box-sizing: border-box; }
  body { margin:0; background:var(--bg); color:var(--ink); font:16px/1.6 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif; }
  header { padding:2.5rem 1.5rem; text-align:center; border-bottom:1px solid var(--line); }
  h1 { margin:0.25rem 0 0; font-family:Georgia,serif; }
  main { max-width:960px; margin:0 auto; padding:2rem 1.5rem 4rem; }
  ul { list-style:none; padding:0; margin:0; display:grid; grid-template-columns:repeat(auto-fill,minmax(280px,1fr)); gap:1rem; }
  .card { border:1px solid var(--line); border-radius:12px; background:var(--card); padding:1.1rem 1.2rem; }
  .row { display:flex; justify-content:space-between; align-items:baseline; gap:0.5rem; }
  .p-name { color:var(--accent); font-weight:700; font-size:1.05rem; }
  .p-kind { font-size:0.7rem; color:var(--muted); border:1px solid var(--line); border-radius:999px; padding:0.05rem 0.5rem; text-transform:uppercase; letter-spacing:0.04em; }
  .p-desc { color:var(--ink); margin:0.5rem 0; }
  .p-meta { color:var(--muted); font-size:0.8rem; }
  .p-use { display:block; margin-top:0.6rem; font-size:0.72rem; color:var(--muted); background:var(--bg); border-radius:6px; padding:0.3rem 0.5rem; overflow:auto; }
  footer { text-align:center; color:var(--muted); padding:2rem; font-size:0.85rem; }
</style>
</head>
<body>
<header><div style="font-size:2rem">☕</div><h1>BrewDocs Marketplace</h1>
<p style="color:var(--muted)">${entries.length} plugin(s) in the registry</p></header>
<main>${entries.length ? `<ul>${cards}</ul>` : '<p style="color:var(--muted);text-align:center">Nothing published yet — try <code>brewdocs registry publish ./my-plugin.cjs --name my-plugin --version 0.1.0</code></p>'}</main>
<footer>Brewed with <a href="#" style="color:var(--accent)">BrewDocs</a> — Brew your docs, serve them hot.</footer>
</body>
</html>`;
  fs.mkdirSync(outDir, { recursive: true });
  const file = path.join(outDir, "index.html");
  fs.writeFileSync(file, html, "utf8");
  return file;
}
