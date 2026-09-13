import * as fs from "node:fs";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import { createRequire } from "node:module";
import type { ExtractResult, Source, SymbolDoc } from "./types.js";
import type { ThemeVars } from "./themes.js";
import { pythonAdapter } from "./extractors/python.js";
import { goAdapter } from "./extractors/go.js";

/**
 * v2.0 plugin/adapter SDK. A plugin is a plain object (or module default
 * export) that can hook into the pipeline at four points:
 *
 *   adapters    — language backends that extract symbols (Python, Go, …)
 *   onExtract   — mutate/filter the ExtractResult after extraction
 *   onRender    — mutate the final HTML of every rendered page
 *   theme       — palette overrides + layout-slot partials merged into the theme
 *
 * Loaders accept local paths (relative to the source root) or package names
 * resolvable from it (e.g. "@brewdocs/python"). Synchronous via
 * createRequire so the whole build stays sync; ESM plugin modules are loaded
 * through a sync dynamic-import shim documented in `loadPlugin`.
 */

/** Context handed to language adapters. */
export interface AdapterContext {
  root: string;
  name?: string;
  /** Raw package.json / pyproject.toml style metadata (empty if none). */
  metadata: Record<string, unknown>;
}

/** A pluggable language backend. */
export interface LanguageAdapter {
  /** Stable id, e.g. "python", "go". */
  id: string;
  /** True when this adapter can extract symbols from `root`. */
  detect(ctx: AdapterContext): boolean;
  /** Extract exported/published symbols; throw or return [] on failure. */
  extract(ctx: AdapterContext): SymbolDoc[];
}

/** Layout slots a plugin or theme manifest can fill (HTML strings). */
export interface ThemeSlotPartials {
  head?: string;
  header?: string;
  mainBefore?: string;
  mainAfter?: string;
  footer?: string;
}

/** Palette/slot contributions merged after the base theme. */
export interface ThemeContribution {
  vars?: ThemeVars;
  darkVars?: ThemeVars;
  slots?: ThemeSlotPartials;
}

export interface BrewDocsPlugin {
  name: string;
  adapters?: LanguageAdapter[];
  onExtract?(result: ExtractResult, source: Source): ExtractResult | void;
  onRender?(html: string, page: { path: string }): string;
  theme?: ThemeContribution;
}

/** Built-in language adapters, always available, zero new dependencies. */
export const BUILTIN_PLUGINS: BrewDocsPlugin[] = [
  { name: "brewdocs:python", adapters: [pythonAdapter] },
  { name: "brewdocs:go", adapters: [goAdapter] },
];

function normalizePlugin(mod: unknown, id: string): BrewDocsPlugin | null {
  const m = mod as {
    default?: unknown;
    plugin?: unknown;
    adapters?: unknown;
    onExtract?: unknown;
    onRender?: unknown;
    theme?: unknown;
    name?: unknown;
  };
  // Precedence: default export, named `plugin` export, or the module itself
  // when it structurally looks like a plugin.
  let candidate: unknown = m.default ?? m.plugin;
  if (
    candidate === undefined &&
    (m.adapters || m.onExtract || m.onRender || m.theme)
  ) {
    candidate = m;
  }
  if (!candidate || typeof candidate !== "object") return null;
  const p = candidate as Partial<BrewDocsPlugin>;
  if (!p.name && typeof p.adapters !== "object" && !p.onExtract && !p.onRender && !p.theme) {
    return null;
  }
  return { name: typeof p.name === "string" ? p.name : id, ...p } as BrewDocsPlugin;
}

/**
 * Load one plugin by local path (`.js`/`.cjs`/`.ts`, relative to `root`) or
 * package name resolvable from `root`. CJS/TS via require; pure-ESM packages
 * fall back to the nearest synchronous harness (import can't be sync — the
 * async variant `loadPluginAsync` covers those).
 */
export function loadPlugin(id: string, root: string): BrewDocsPlugin | null {
  const abs = id.startsWith(".") || path.isAbsolute(id)
    ? path.resolve(root, id)
    : undefined;
  if (abs) {
    if (!fs.existsSync(abs)) return null;
    return normalizePlugin(requireFrom(root)(abs), path.basename(abs, path.extname(abs)));
  }
  try {
    return normalizePlugin(requireFrom(root)(id), id);
  } catch {
    return null;
  }
}

/** Async variant supporting ESM plugin modules too (under `tsx`, `.ts` plugins work). */
export async function loadPluginAsync(id: string, root: string): Promise<BrewDocsPlugin | null> {
  const sync = loadPlugin(id, root);
  if (sync) return sync;
  const abs = id.startsWith(".") || path.isAbsolute(id) ? path.resolve(root, id) : null;
  const target = abs ?? id;
  try {
    const mod = await import(pathToFileURL(target).href);
    return normalizePlugin(mod, abs ? path.basename(abs, path.extname(abs)) : id);
  } catch {
    return null;
  }
}

function requireFrom(root: string): NodeRequire {
  return createRequire(path.join(path.resolve(root), "index.js"));
}

/** Resolve plugin specifiers (paths/names) against a source root, dropping unknowns. */
export function loadPlugins(specs: string[] | undefined, root: string): BrewDocsPlugin[] {
  if (!specs || specs.length === 0) return [];
  const plugins: BrewDocsPlugin[] = [];
  for (const spec of specs) {
    const p = loadPlugin(spec, root);
    if (p) plugins.push(p);
    else console.warn(`[brewdocs] plugin "${spec}" not found or invalid — skipped`);
  }
  return plugins;
}

/** All adapters from built-in + user plugins, user plugins first (they win detection order). */
export function collectAdapters(plugins: BrewDocsPlugin[]): LanguageAdapter[] {
  const adapters: LanguageAdapter[] = [];
  for (const p of plugins) adapters.push(...(p.adapters ?? []));
  for (const p of BUILTIN_PLUGINS) adapters.push(...(p.adapters ?? []));
  return adapters;
}

/** Run every adapter whose `detect` matched, deduping symbol names (first wins). */
export function runAdapters(
  plugins: BrewDocsPlugin[],
  ctx: AdapterContext,
): SymbolDoc[] {
  const out: SymbolDoc[] = [];
  const seen = new Set<string>();
  for (const adapter of collectAdapters(plugins)) {
    let symbols: SymbolDoc[] = [];
    try {
      if (!adapter.detect(ctx)) continue;
      symbols = adapter.extract(ctx) ?? [];
    } catch (err) {
      console.warn(
        `[brewdocs] adapter "${adapter.id}" failed: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      continue;
    }
    for (const s of symbols) {
      if (seen.has(s.name)) continue;
      seen.add(s.name);
      out.push(s);
    }
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

/** Fold the onExtract hook over a fresh result (plugins may replace it). */
export function applyOnExtract(
  plugins: BrewDocsPlugin[],
  result: ExtractResult,
  source: Source,
): ExtractResult {
  let current = result;
  for (const p of plugins) {
    if (!p.onExtract) continue;
    try {
      const next = p.onExtract(current, source);
      if (next) current = next;
    } catch (err) {
      console.warn(
        `[brewdocs] plugin "${p.name}" onExtract failed: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }
  return current;
}

/** Fold the onRender hook over a finished page (plugin errors keep the page). */
export function applyOnRender(
  plugins: BrewDocsPlugin[],
  html: string,
  page: { path: string },
): string {
  let current = html;
  for (const p of plugins) {
    if (!p.onRender) continue;
    try {
      const next = p.onRender(current, page);
      if (typeof next === "string") current = next;
    } catch (err) {
      console.warn(
        `[brewdocs] plugin "${p.name}" onRender failed: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }
  return current;
}

/** Merge every plugin's theme contribution into one (later wins per key). */
export function mergePluginThemes(plugins: BrewDocsPlugin[]): ThemeContribution | undefined {
  const merged: ThemeContribution = { vars: {}, darkVars: {}, slots: {} };
  let any = false;
  for (const p of plugins) {
    const t = p.theme;
    if (!t) continue;
    any = true;
    Object.assign(merged.vars!, t.vars ?? {});
    Object.assign(merged.darkVars!, t.darkVars ?? {});
    Object.assign(merged.slots!, t.slots ?? {});
  }
  return any ? merged : undefined;
}
