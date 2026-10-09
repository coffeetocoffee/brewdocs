import * as fs from "node:fs";
import * as path from "node:path";
import type { ThemeManifest } from "./types.js";
import type { Theme, ThemeVars } from "./themes.js";
import { getTheme, isBuiltinTheme } from "./themes.js";
import { loadConfig } from "./config.js";

/**
 * v2.0 theming engine: theme manifests (`themes/<name>.yml|json`) that extend
 * a built-in base, override palette vars, and fill layout slots
 * (head / header / mainBefore / mainAfter / footer) from inline HTML or
 * partial files. A manifest is also a valid value for `--theme`.
 */

const SLOT_KEYS = ["head", "header", "mainBefore", "mainAfter", "footer"] as const;
/** Named theme slots a manifest may override (hero, mainBefore, mainAfter, footer). */
export type SlotName = (typeof SLOT_KEYS)[number];
/** Manifest slot overrides: slot name -> inline HTML or a confined partial path. */
export type Slots = Partial<Record<SlotName, string>>;

/**
 * Does this theme reference name a file rather than a bare theme name?
 *
 * Only an explicit path may select a repo-supplied manifest on a fetched
 * source (finding #32): `--theme brand` against a repo you do not own is the
 * repo choosing the markup, while `--theme ./themes/brand.yml` is the
 * operator's own decision — the same line D-9 draws for plugins.
 *
 * @param ref - theme reference from CLI/config.
 * @returns true when the reference looks like a path or a manifest filename.
 */
function isExplicitThemePath(ref: string): boolean {
  return /[\\/]/.test(ref) || /\.(ya?ml|json)$/i.test(ref);
}

/**
 * Theme warnings already emitted this process. `pageShell` resolves the theme
 * once per rendered page, so without this a fetched source's dropped theme
 * would print the same warning for every page of a `--multi` build.
 */
const warnedThemes = new Set<string>();

/**
 * Test hook: clear the warn-once memory so each test starts clean.
 *
 * @returns nothing; resets the module-level warning cache in place.
 */
export function __resetThemeWarnings(): void {
  warnedThemes.clear();
}

function warnOnce(msg: string): void {
  if (warnedThemes.has(msg)) return;
  warnedThemes.add(msg);
  console.warn(msg);
}

function parseScalar(raw: string): string {
  return raw.trim().replace(/^["']|["']$/g, "");
}

/**
 * Tiny YAML reader for the manifest subset: scalar keys plus one-level
 * nested maps (`vars:`, `darkVars:`, `slots:`). Values are strings.
 */
function parseManifestYaml(text: string): Record<string, unknown> {
  const obj: Record<string, unknown> = {};
  let currentMap: Record<string, string> | null = null;
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim() || line.trim().startsWith("#")) continue;
    const m = /^(\s*)([\w-]+):\s*(.*)$/.exec(line);
    if (!m) continue;
    const key = m[2];
    const val = m[3];
    if (m[1].length === 0) {
      if (!val) {
        currentMap = {};
        obj[key] = currentMap;
      } else {
        currentMap = null;
        obj[key] = parseScalar(val);
      }
    } else if (currentMap) {
      currentMap[key] = parseScalar(val);
    }
  }
  return obj;
}

function asVars(v: unknown): ThemeVars | undefined {
  if (!v || typeof v !== "object") return undefined;
  const out: ThemeVars = {};
  for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
    if (typeof val === "string") out[k.startsWith("--") ? k : `--${k}`] = val;
  }
  return Object.keys(out).length ? out : undefined;
}

function asSlots(v: unknown): ThemeManifest["slots"] | undefined {
  if (!v || typeof v !== "object") return undefined;
  const raw = v as Record<string, unknown>;
  const slots: ThemeManifest["slots"] = {};
  for (const k of SLOT_KEYS) {
    if (typeof raw[k] === "string") slots[k] = raw[k];
  }
  return Object.keys(slots).length ? slots : undefined;
}

function normalizeManifest(obj: Record<string, unknown>, fallbackName: string): ThemeManifest {
  const slotsRaw = obj.slots ?? obj.partials;
  return {
    name: typeof obj.name === "string" ? obj.name : fallbackName,
    extends: typeof obj.base === "string" ? obj.base : typeof obj.extends === "string" ? obj.extends : undefined,
    vars: asVars(obj.vars),
    darkVars: asVars(obj.darkVars ?? obj.varsDark),
    css: typeof obj.css === "string" ? obj.css : undefined,
    slots: asSlots(slotsRaw),
  };
}

function readManifestFile(file: string, sourceRoot?: string): ThemeManifest | null {
  try {
    const text = fs.readFileSync(file, "utf8");
    const ext = path.extname(file);
    const obj =
      ext === ".json"
        ? (JSON.parse(text) as Record<string, unknown>)
        : parseManifestYaml(text);
    const manifest = normalizeManifest(obj, path.basename(file, ext));
    manifest.manifestDir = path.dirname(file);
    // v3.8: remember the source root so slot partial paths can be confined to
    // it. A manifest is repo-controlled config, so a slot value naming a file
    // outside the repo must not be readable.
    manifest.sourceRoot = sourceRoot;
    return manifest;
  } catch {
    return null;
  }
}

/**
 * Resolve a theme reference to a manifest, searching (in order):
 * the literal path, `themes/<ref>.yml|json` under root, and a
 * `themeFile`/`theme: path` from brewdocs.yml. Returns null for built-ins.
 *
 * Two provenance guards live here (finding #32). A bare built-in name never
 * resolves to a repo file, so `--theme ink` cannot be hijacked by a repo that
 * ships `themes/ink.yml`. And a fetched (npm/git) source may not name a theme
 * by bare name.
 *
 * Note which half is load-bearing: this function only sees a reference, so it
 * cannot tell who supplied it. The primary guard is upstream (resolveSetup in
 * build.ts), which drops the repo's own `theme`/`themeFile` config on a
 * fetched source so that an explicit path can only ever arrive from
 * `options.theme` — the operator's --theme. Testing the reference's *shape*
 * here was the first, bypassable version of this fix: a repo writing
 * `theme: ./themes/evil.yml` in its own config supplied a path-shaped string.
 *
 * @param ref - theme reference: literal path or `themes/<name>` (undefined yields null).
 * @param root - source root the reference is resolved against.
 * @param opts - `fetched` marks a source the operator did not choose locally.
 * @returns the parsed theme manifest, or null when no manifest file matches.
 */
export function loadThemeManifest(
  ref: string | undefined,
  root: string,
  opts: { fetched?: boolean } = {},
): ThemeManifest | null {
  if (!ref) return null;
  // A bundled name must resolve to the bundle. `--theme ink` is the documented
  // invocation, so a repo shipping themes/ink.yml could otherwise replace the
  // built-in — and a manifest carries raw slot HTML and css.
  if (isBuiltinTheme(ref) && !isExplicitThemePath(ref)) return null;
  // On a fetched source the bare name is the *repo's* choice, not the operator's.
  if (opts.fetched && !isExplicitThemePath(ref)) {
    warnOnce(
      `[brewdocs] ignoring theme "${ref}" — a fetched source cannot choose its own theme (pass --theme with an explicit path to use one deliberately)`,
    );
    return null;
  }
  const direct = [ref, `${ref}.yml`, `${ref}.json`].map((p) => path.resolve(root, p));
  for (const file of direct) {
    if (fs.existsSync(file) && /\.(yml|json)$/.test(file)) {
      return readManifestFile(file, root);
    }
  }
  const inDir = [
    path.join(root, "themes", `${ref}.yml`),
    path.join(root, "themes", `${ref}.json`),
  ];
  for (const file of inDir) {
    if (fs.existsSync(file)) return readManifestFile(file, root);
  }
  return null;
}

/**
 * Theme name from `--theme`/config plus optional manifest override.
 *
 * @param ref - explicit theme reference from the caller, if any.
 * @param root - source root used to locate a manifest and read brewdocs.yml.
 * @param opts - `fetched` marks a source the operator did not choose locally.
 * @returns the base theme name and the manifest, when one was found.
 */
export function resolveThemeRef(
  ref: string | undefined,
  root: string,
  opts: { fetched?: boolean } = {},
): { name?: string; manifest?: ThemeManifest } {
  const config = loadConfig(root);
  // `themeFile` is the repo's own config key, so a fetched source may not use
  // it — the operator's explicit ref is the only way in.
  const repoThemeFile = opts.fetched ? undefined : config.themeFile;
  const candidate = ref ?? repoThemeFile;
  if (!candidate) return {};
  const manifest =
    loadThemeManifest(candidate, root, opts) ??
    (repoThemeFile && repoThemeFile !== candidate
      ? loadThemeManifest(repoThemeFile, root, opts)
      : null);
  if (manifest) return { name: manifest.extends, manifest };
  return { name: candidate };
}

/**
 * Fill a slots map from a manifest (inline HTML or partial file paths).
 *
 * v3.8: a partial path is confined to the manifest's source root. Slot values
 * are repo-controlled config, so without this a `themes/brand.yml` shipped by
 * the repo being documented could name `../../id_rsa`, and the build would read
 * it and embed it in a page the user then publishes.
 *
 * @param manifest - theme manifest whose slots are materialized.
 * @returns the resolved slot partials (inline HTML or file contents).
 */
export function manifestSlots(manifest: ThemeManifest | undefined): Slots {
  const slots: Slots = {};
  if (!manifest?.slots) return slots;
  const root = manifest.sourceRoot ? path.resolve(manifest.sourceRoot) : null;
  for (const key of SLOT_KEYS) {
    const value = manifest.slots[key];
    if (!value) continue;
    if (/<[a-zA-Z/!]/.test(value)) {
      slots[key] = value; // inline HTML
      continue;
    }
    const file = path.resolve(manifest.manifestDir ?? ".", value);
    if (root) {
      // Boundary-aware: `..` is collapsed by resolve() before the comparison,
      // and the result must be the root or sit under root + separator.
      const inRoot = file === root || file.startsWith(root + path.sep);
      if (!inRoot) {
        console.warn(
          `[brewdocs] theme slot "${key}" skipped: partial escapes the source root`,
        );
        continue;
      }
    }
    try {
      if (fs.existsSync(file)) slots[key] = fs.readFileSync(file, "utf8");
    } catch {
      /* unreadable partial: skip */
    }
  }
  return slots;
}

/**
 * Apply a manifest on top of a base theme: vars, dark vars, and css extra.
 *
 * @param base - base theme to merge onto.
 * @param manifest - manifest overrides, or undefined to return the base unchanged.
 * @returns the merged theme with an optional extra css string.
 */
export function applyManifest(base: Theme, manifest: ThemeManifest | undefined): Theme & { css?: string } {
  if (!manifest) return { ...base };
  const light: ThemeVars = { ...base.light, ...(manifest.vars ?? {}) };
  const dark: ThemeVars = { ...base.dark, ...(manifest.darkVars ?? {}) };
  return {
    name: manifest.name,
    label: manifest.name,
    light,
    dark,
    css: manifest.css,
  };
}

/**
 * Full resolution used by the renderer: built-in lookup + manifest merge.
 *
 * @param ref - theme reference from CLI/config (undefined uses the default theme).
 * @param root - source root used to resolve a manifest; omit for built-ins only.
 * @param fetched - true when the source came from npm/git (finding #32).
 * @returns the resolved theme, merged with any manifest customizations.
 */
export function themeFromRef(
  ref: string | undefined,
  root?: string,
  fetched?: boolean,
): Theme & { css?: string } {
  if (!root) return getTheme(ref);
  const { name, manifest } = resolveThemeRef(ref, root, { fetched });
  return applyManifest(getTheme(name), manifest ?? undefined);
}
