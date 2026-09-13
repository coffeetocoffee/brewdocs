import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import type { ExtractResult, Source } from "./types.js";
import { extractFromSource } from "./extract.js";
import { loadConfig } from "./config.js";
import type { BrewDocsPlugin } from "./plugins.js";

/**
 * v2.0 incremental extraction: content-address the source tree, cache the
 * (expensive) ExtractResult under `.brewdocs/extract.json`, and reuse it
 * byte-for-byte when nothing relevant changed. Only extraction is cached —
 * rendering is fast and theme/content inputs are checked per build.
 */

const CACHE_VERSION = 1;

/** Dirs never worth hashing (build output, deps, VCS, the cache itself). */
const SKIP_DIRS = new Set([
  "node_modules",
  ".git",
  ".brewdocs",
  "dist",
  ".next",
  ".cache",
  "coverage",
]);

/** File types that influence the ExtractResult. */
const RELEVANT_EXT = new Set([".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".md", ".json"]);
const ALWAYS_RELEVANT = new Set([
  "package.json",
  "pyproject.toml",
  "go.mod",
  "setup.py",
  "brewdocs.yml",
  "brewdocs.json",
]);

function hashFile(file: string): string {
  try {
    const h = crypto.createHash("sha256");
    h.update(fs.readFileSync(file));
    return h.digest("hex");
  } catch {
    return "unreadable";
  }
}

function walk(dir: string, root: string, entries: string[]): void {
  let items: fs.Dirent[];
  try {
    items = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const item of items) {
    if (!item.isDirectory() && !item.isFile()) continue;
    if (item.isDirectory() && SKIP_DIRS.has(item.name)) continue;
    const abs = path.join(dir, item.name);
    if (item.isDirectory()) {
      walk(abs, root, entries);
      continue;
    }
    const rel = path.relative(root, abs).replace(/\\/g, "/");
    const ext = path.extname(item.name);
    if (!ALWAYS_RELEVANT.has(item.name) && !RELEVANT_EXT.has(ext)) continue;
    // Lockfiles/package-manager noise: huge, irrelevant to the doc model.
    if (item.name === "package-lock.json" || item.name === "bun.lockb") continue;
    entries.push(rel);
  }
}

/**
 * Deterministic fingerprint of every relevant file: relpath + content hash.
 * Paths are part of the digest so renames/moves invalidate correctly.
 */
export function fingerprintSource(root: string): string {
  const abs = path.resolve(root);
  const files: string[] = [];
  walk(abs, abs, files);
  files.sort();
  const h = crypto.createHash("sha256");
  h.update(`brewdocs-cache-v${CACHE_VERSION}\n`);
  for (const rel of files) {
    h.update(rel);
    h.update("\0");
    h.update(hashFile(path.join(abs, rel)));
    h.update("\n");
  }
  return h.digest("hex");
}

export function cacheFile(root: string): string {
  return path.join(path.resolve(root), ".brewdocs", "extract.json");
}

interface CacheShape {
  version: number;
  fingerprint: string;
  result: ExtractResult;
}

function readCache(root: string, fingerprint: string): ExtractResult | null {
  try {
    const raw = JSON.parse(fs.readFileSync(cacheFile(root), "utf8")) as CacheShape;
    if (raw.version !== CACHE_VERSION || raw.fingerprint !== fingerprint) return null;
    if (!raw.result || !Array.isArray(raw.result.symbols)) return null;
    return raw.result;
  } catch {
    return null;
  }
}

function writeCache(root: string, fingerprint: string, result: ExtractResult): void {
  try {
    const dir = path.dirname(cacheFile(root));
    fs.mkdirSync(dir, { recursive: true });
    // Round-trip through JSON so the cached shape always matches what a
    // fresh extraction would produce (no live object aliases).
    const serializable = JSON.parse(JSON.stringify(result)) as ExtractResult;
    const shape: CacheShape = { version: CACHE_VERSION, fingerprint, result: serializable };
    fs.writeFileSync(cacheFile(root), JSON.stringify(shape), "utf8");
  } catch {
    /* cache write failure must never break a build */
  }
}

export interface CachedExtractOptions {
  /** Force the cache on/off; defaults to `cache: true` in brewdocs.yml. */
  enabled?: boolean;
  /** v2.0 plugins (user adapters/hooks bypass the shared cache key). */
  plugins?: BrewDocsPlugin[];
}

/**
 * `extractFromSource` with the incremental cache layered around it.
 * Cache is keyed on the source root's fingerprint AND the plugin set, so
 * adding/removing a plugin invalidates; `--cache`/`cache: true` opts in and
 * `--no-cache`/`cache: false` opts out (default: off, matching v1 behavior).
 */
export function extractCached(
  source: Source,
  opts: CachedExtractOptions = {},
): ExtractResult {
  const root = path.resolve(source.root);
  const config = loadConfig(root);
  const enabled = opts.enabled ?? Boolean(config.cache);
  if (!enabled) return extractFromSource(source, opts.plugins);

  // Plugin hooks change the result, so the fingerprint includes the plugin
  // names; adapters are covered transitively by their source files.
  const plugins = opts.plugins ?? [];
  const fingerprint = fingerprintSource(root) + "|" + plugins.map((p) => p.name).join(",");
  const cached = readCache(root, fingerprint);
  if (cached) return cached;

  const fresh = extractFromSource(source, plugins);
  writeCache(root, fingerprint, fresh);
  return fresh;
}

/** Remove the on-disk cache (used by tests and `brewdocs cache clear`). */
export function clearCache(root: string): boolean {
  try {
    fs.rmSync(cacheFile(root), { force: true });
    return true;
  } catch {
    return false;
  }
}
