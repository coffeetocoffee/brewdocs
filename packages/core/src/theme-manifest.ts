import * as fs from "node:fs";
import * as path from "node:path";
import type { ThemeManifest } from "./types.js";
import type { Theme, ThemeVars } from "./themes.js";
import { getTheme } from "./themes.js";
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
 * @param ref - theme reference: literal path or `themes/<name>` (undefined yields null).
 * @param root - source root the reference is resolved against.
 * @returns the parsed theme manifest, or null when no manifest file matches.
 */
export function loadThemeManifest(ref: string | undefined, root: string): ThemeManifest | null {
  if (!ref) return null;
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
 * @returns the base theme name and the manifest, when one was found.
 */
export function resolveThemeRef(ref: string | undefined, root: string): { name?: string; manifest?: ThemeManifest } {
  const config = loadConfig(root);
  const candidate = ref ?? config.themeFile;
  if (!candidate) return {};
  const manifest =
    loadThemeManifest(candidate, root) ??
    (config.themeFile && config.themeFile !== candidate
      ? loadThemeManifest(config.themeFile, root)
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
 * @returns the resolved theme, merged with any manifest customizations.
 */
export function themeFromRef(ref: string | undefined, root?: string): Theme & { css?: string } {
  if (!root) return getTheme(ref);
  const { name, manifest } = resolveThemeRef(ref, root);
  return applyManifest(getTheme(name), manifest ?? undefined);
}
