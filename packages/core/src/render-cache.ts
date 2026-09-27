import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import type { RenderModel } from "./types.js";
import type { RenderOptions, RenderedPage } from "./render.js";

/**
 * Whole-render cache. Extraction is already cached (cache.ts); rendering is
 * not, and `--multi` renders one page per symbol — the expensive half. Render
 * output is a pure function of the render model plus the serializable
 * options, so key on exactly those and reuse the page set.
 *
 * Freshness stamps are deliberately NOT in the key: a reused page keeps the
 * timestamp of when it was first rendered. Bump RENDER_VERSION whenever the
 * rendered output changes shape.
 */
const RENDER_VERSION = 1;

/** Order-independent JSON so key insertion order never changes the digest. */
function stable(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  const obj = value as Record<string, unknown>;
  return `{${Object.keys(obj)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${stable(obj[k])}`)
    .join(",")}}`;
}

/**
 * Fingerprint of everything that shapes the rendered HTML. Function-valued
 * options (slots are already strings, plugins) reduce to their names — a
 * plugin whose output depends on wall-clock time is out of scope here.
 */
export function renderFingerprint(model: RenderModel, options: RenderOptions = {}): string {
  const opts = {
    theme: options.theme ?? null,
    dark: options.dark ?? null,
    locale: options.locale ?? null,
    playground: options.playground ?? null,
    multiPage: options.multiPage ?? null,
    currentVersion: options.currentVersion ?? null,
    eol: options.eol ?? null,
    versions: options.versions ?? null,
    externalLinks: options.externalLinks ?? null,
    slots: options.slots ?? null,
    plugins: (options.plugins ?? []).map((p) => p.name),
  };
  const h = crypto.createHash("sha256");
  h.update(`brewdocs-render-v${RENDER_VERSION}\n`);
  h.update(stable({ model, opts }));
  return h.digest("hex");
}

export function renderCacheFile(root: string): string {
  return path.join(path.resolve(root), ".brewdocs", "render.json");
}

interface RenderCacheShape {
  version: number;
  fingerprint: string;
  pages: RenderedPage[];
}

function readRenderCache(root: string, fingerprint: string): RenderedPage[] | null {
  try {
    const raw = JSON.parse(fs.readFileSync(renderCacheFile(root), "utf8")) as RenderCacheShape;
    if (raw.version !== RENDER_VERSION || raw.fingerprint !== fingerprint) return null;
    if (!Array.isArray(raw.pages)) return null;
    return raw.pages;
  } catch {
    return null;
  }
}

function writeRenderCache(root: string, fingerprint: string, pages: RenderedPage[]): void {
  try {
    fs.mkdirSync(path.dirname(renderCacheFile(root)), { recursive: true });
    const shape: RenderCacheShape = { version: RENDER_VERSION, fingerprint, pages };
    fs.writeFileSync(renderCacheFile(root), JSON.stringify(shape), "utf8");
  } catch {
    /* cache write failure must never break a build */
  }
}

/** Render via `produce`, unless an identical render is already cached. */
export function renderCached(
  root: string,
  fingerprint: string,
  enabled: boolean,
  produce: () => RenderedPage[],
): RenderedPage[] {
  if (!enabled) return produce();
  const cached = readRenderCache(root, fingerprint);
  if (cached) return cached;
  const pages = produce();
  writeRenderCache(root, fingerprint, pages);
  return pages;
}

/** Remove the render cache (used by tests and `brewdocs cache clear`). */
export function clearRenderCache(root: string): boolean {
  try {
    fs.rmSync(renderCacheFile(root), { force: true });
    return true;
  } catch {
    return false;
  }
}
