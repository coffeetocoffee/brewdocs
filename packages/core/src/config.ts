import * as fs from "node:fs";
import * as path from "node:path";
import { listLocales } from "./i18n.js";

/**
 * Config warnings already emitted this process, so the many `loadConfig`
 * calls in one build (cache, content, theme, deploy, each command) do not
 * repeat the same complaint. Keyed on the message text.
 */
const warnedMessages = new Set<string>();

/**
 * Test hook: clear the warn-once memory so each test starts clean.
 *
 * @returns nothing; resets the module-level warning cache in place.
 */
export function __resetConfigWarnings(): void {
  warnedMessages.clear();
}

/** Parsed `brewdocs.yml`/`brewdocs.json` (unknown or invalid keys are warned and dropped). */
export interface BrewDocsConfig {
  theme?: string;
  dark?: boolean;
  name?: string;
  multi?: boolean;
  storage?: "local" | "s3";
  /** Org namespace for hosted (multi-tenant) deploys. */
  org?: string;
  /** Deploy as a private (token-gated) site. */
  private?: boolean;
  /** `brewdocs doctor` fails (exit 1) when coverage drops below this. */
  minCoverage?: number;
  /** Ship `docmodel.json` with every build (default true; `docmodel: false` opts out). */
  docmodel?: boolean;
  /** v2.0: plugin module paths/names loaded relative to the source root. */
  plugins?: string[];
  /** v2.0: enable incremental extraction caching (`.brewdocs/extract.json`). */
  cache?: boolean;
  /** v2.0: content directory for authored guide pages (default `content`). */
  contentDir?: string;
  /** v2.0: named theme manifest (resolved in `themes/` or as a file path). */
  themeFile?: string;
  /** v2.5: editable in-page "Try it" editors under each symbol example. */
  playground?: boolean;
  /** v3.0: UI locale for rendered chrome (see i18n.ts; default "en"). */
  locale?: string;
  /** v3.0: alias name -> version, e.g. `latest: 2.5.0` (redirect pages). */
  aliases?: Record<string, string>;
  /** v3.0: versions (or `"1.x"` major patterns) flagged end-of-life. */
  eol?: string[];
  /** v3.0: moved pages: old path -> new path, relative to the site root. */
  redirects?: Record<string, string>;
  /** v3.0: directory of the local plugin registry (marketplace store). */
  registry?: string;
  s3?: {
    bucket?: string;
    region?: string;
    endpoint?: string;
    accessKeyId?: string;
    secretAccessKey?: string;
    publicDomain?: string;
  };
  version?: string;
  /** Format version of this config file (see CURRENT_CONFIG_VERSION). */
  configVersion?: number;
}

/** Config format version this build understands; written by `brewdocs migrate`. */
export const CURRENT_CONFIG_VERSION = 2;

function parseScalar(raw: string): string | boolean {
  const v = raw.trim();
  if (v === "true") return true;
  if (v === "false") return false;
  return v.replace(/^["']|["']$/g, "");
}

/** `["a", "b"]`-style inline sequence; returns undefined when not one. */
function parseInlineList(raw: string): string[] | undefined {
  const v = raw.trim();
  if (!v.startsWith("[") || !v.endsWith("]")) return undefined;
  return v
    .slice(1, -1)
    .split(",")
    .map((s) => s.trim().replace(/^["']|["']$/g, ""))
    .filter(Boolean);
}

/**
 * Minimal YAML reader: supports top-level `key: value` pairs (scalars,
 * booleans, inline lists), block sequences (`plugins:\n  - x`), and nested
 * string-map blocks (`s3:`, `aliases:`, `redirects:`). Enough for
 * brewdocs.yml without pulling in a YAML dep.
 */
const MAP_SECTIONS = new Set(["s3", "aliases", "redirects"]);

/**
 * Expected shape per top-level key: "string" | "boolean" | "number" | "list"
 * | "map". A typo used to be stored silently and never read, so the user
 * changed a setting and nothing happened. Validating here turns that into a
 * warning naming the key and the likely fix.
 */
const KEY_KINDS: Record<string, string> = {
  theme: "string",
  dark: "boolean",
  name: "string",
  multi: "boolean",
  storage: "string",
  org: "string",
  private: "boolean",
  minCoverage: "number",
  docmodel: "boolean",
  plugins: "list",
  cache: "boolean",
  contentDir: "string",
  themeFile: "string",
  playground: "boolean",
  locale: "string",
  aliases: "map",
  eol: "list",
  redirects: "map",
  registry: "string",
  s3: "map",
  version: "string",
  configVersion: "number",
};

/**
 * Keys whose value is one of a fixed set, not a free string. `matchesKind`
 * only checks the JSON shape, so these need an explicit value check — a typo
 * like `storage: lcoal` is a valid *string* and would otherwise be accepted
 * and silently ignored.
 */
const KEY_ENUMS: Record<string, readonly string[]> = {
  storage: ["local", "s3"],
  locale: listLocales().map((l) => l.code),
};

/**
 * Enum membership for a config key. `locale` mirrors `normalizeLocale`: it
 * accepts `id-ID`/`EN`/`pt-BR` forms and only rejects a base code that is not
 * one of the bundled locales (`xx` would silently fall back to `en`).
 */
function enumAllows(key: string, value: unknown): boolean {
  if (typeof value !== "string") return false;
  const allowed = KEY_ENUMS[key] ?? [];
  if (key === "locale") {
    const base = value.toLowerCase().split(/[-_]/)[0];
    return allowed.includes(base);
  }
  return allowed.includes(value);
}

/** Levenshtein distance, capped — only used to suggest a near-miss key. */
function editDistance(a: string, b: string): number {
  const m = a.length;
  const n = b.length;
  const prev = new Array<number>(n + 1);
  const cur = new Array<number>(n + 1);
  for (let j = 0; j <= n; j++) prev[j] = j;
  for (let i = 1; i <= m; i++) {
    cur[0] = i;
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost);
    }
    for (let j = 0; j <= n; j++) prev[j] = cur[j];
  }
  return prev[n];
}

function nearestKey(key: string): string | undefined {
  let best: string | undefined;
  let bestDist = 3; // suggestions only when plausibly a typo
  for (const known of Object.keys(KEY_KINDS)) {
    const d = editDistance(key, known);
    if (d < bestDist) {
      bestDist = d;
      best = known;
    }
  }
  return best;
}

function matchesKind(kind: string, value: unknown): boolean {
  switch (kind) {
    case "string":
      return typeof value === "string";
    case "boolean":
      return typeof value === "boolean";
    case "number":
      // The mini-YAML leaves numbers as strings (`minCoverage: 80`), so accept
      // a numeric string as well as a real number.
      return (
        typeof value === "number" ||
        (typeof value === "string" && value.trim() !== "" && !Number.isNaN(Number(value)))
      );
    case "list":
      return Array.isArray(value);
    case "map":
      return Boolean(value) && typeof value === "object" && !Array.isArray(value);
    default:
      return true;
  }
}

/**
 * Warn (never throw) about config a user can write but the build will not act
 * on: unknown keys and known keys whose value has the wrong shape. Matches the
 * codebase convention — degrade with a warning instead of failing the build.
 */
function validateConfig(cfg: BrewDocsConfig, file: string): string[] {
  const warnings: string[] = [];
  for (const [key, value] of Object.entries(cfg)) {
    const kind = KEY_KINDS[key];
    if (!kind) {
      const near = nearestKey(key);
      warnings.push(
        `unknown key "${key}" in ${file}${near ? ` — did you mean "${near}"?` : ""} (ignored)`,
      );
      delete (cfg as Record<string, unknown>)[key];
      continue;
    }
    if (!matchesKind(kind, value)) {
      warnings.push(
        `"${key}" in ${file} should be a ${kind}, got ${Array.isArray(value) ? "list" : typeof value} (ignored)`,
      );
      delete (cfg as Record<string, unknown>)[key];
      continue;
    }
    // A key with a fixed set of valid values needs a value check too: the
    // `kind` is "string", so `storage: lcoal` satisfies matchesKind and then
    // silently no-ops downstream. Warn + drop instead.
    const allowed = KEY_ENUMS[key];
    if (allowed && !enumAllows(key, value)) {
      warnings.push(
        `"${key}" in ${file} must be one of ${allowed.join(", ")}, got "${String(value)}" (ignored — falling back to the default)`,
      );
      delete (cfg as Record<string, unknown>)[key];
    }
  }
  return warnings;
}

function parseSimpleYaml(text: string): BrewDocsConfig {
  const cfg: BrewDocsConfig = {};
  const lines = text.split(/\r?\n/);
  let section: string | null = null;
  let listKey: string | null = null;
  for (const line of lines) {
    if (!line.trim() || line.trim().startsWith("#")) continue;
    const item = line.match(/^\s+-\s+(.*)$/);
    if (item && listKey) {
      const arr = ((cfg as Record<string, unknown>)[listKey] ??= []) as string[];
      arr.push(String(parseScalar(item[1])));
      continue;
    }
    const m = line.match(/^(\s*)([\w-]+):\s*(.*)$/);
    if (!m) {
      // Nested map entry with a non-word key (redirect paths contain / and .).
      if (section && /^\s+/.test(line)) {
        const mm = line.match(/^\s*([^:]+):\s*(.*)$/);
        if (mm) {
          const map = (cfg as Record<string, unknown>)[section] as Record<string, string>;
          map[mm[1].trim().replace(/^["']|["']$/g, "")] = String(parseScalar(mm[2]));
        }
      }
      continue;
    }
    const indent = m[1].length;
    const key = m[2];
    const val = m[3];
    if (indent === 0) {
      listKey = null;
      if (MAP_SECTIONS.has(key)) {
        section = key;
        (cfg as Record<string, unknown>)[key] = {};
        continue;
      }
      section = null;
      if (!val) {
        // Key with no value: a block sequence (plugins, …) starts here.
        listKey = key;
        (cfg as Record<string, unknown>)[key] = [];
        continue;
      }
      const list = parseInlineList(val);
      if (list) (cfg as Record<string, unknown>)[key] = list;
      else (cfg as Record<string, unknown>)[key] = parseScalar(val);
    } else if (section) {
      const map = (cfg as Record<string, unknown>)[section] as Record<string, string>;
      map[key] = String(parseScalar(val));
    }
  }
  return cfg;
}

/**
 * Load BrewDocs configuration from `brewdocs.yml` or `brewdocs.json` in `root`.
 * Returns an empty object when neither exists.
 *
 * @param root - source root that may contain brewdocs.yml or brewdocs.json.
 * @returns the parsed config (empty when neither file exists or parsing fails).
 */
export function loadConfig(root: string): BrewDocsConfig {
  const yamlPath = path.join(root, "brewdocs.yml");
  const jsonPath = path.join(root, "brewdocs.json");
  // `loadConfig` runs many times per build (cache, content, theme, each
  // command). A config problem is the same every time, so warn once per
  // distinct message per process — otherwise a single typo prints five times.
  const warn = (msg: string) => {
    if (warnedMessages.has(msg)) return;
    warnedMessages.add(msg);
    console.warn(`[brewdocs] ${msg}`);
  };

  let cfg: BrewDocsConfig | undefined;
  let file: string | undefined;
  try {
    if (fs.existsSync(yamlPath)) {
      file = yamlPath;
      cfg = parseSimpleYaml(fs.readFileSync(yamlPath, "utf8"));
    } else if (fs.existsSync(jsonPath)) {
      file = jsonPath;
      cfg = JSON.parse(fs.readFileSync(jsonPath, "utf8")) as BrewDocsConfig;
    }
  } catch (err) {
    // A malformed config used to be swallowed whole, so the build silently ran
    // with no config at all and every setting appeared to do nothing.
    warn(
      `${path.basename(file ?? "brewdocs.yml")} could not be parsed (${err instanceof Error ? err.message : err}) — building with defaults`,
    );
    return {};
  }
  if (!cfg || typeof cfg !== "object") return {};
  if (file) for (const w of validateConfig(cfg, path.basename(file))) warn(w);
  // A version newer than we know means the file uses a format we may misread;
  // an older one is a one-line `brewdocs migrate` away. Absent = legacy, silent.
  const v = asNumber(cfg.configVersion);
  if (v !== undefined) {
    cfg.configVersion = v; // normalize the mini-YAML's numeric string
    if (v > CURRENT_CONFIG_VERSION) {
      warn(
        `configVersion ${v} is newer than this BrewDocs supports (${CURRENT_CONFIG_VERSION}) — update brewdocs`,
      );
    } else if (v < CURRENT_CONFIG_VERSION) {
      warn(`configVersion ${v} is out of date — run \`brewdocs migrate\``);
    }
  }
  return cfg;
}

/** Local coercion for the numeric-string the mini-YAML produces. */
function asNumber(value: unknown): number | undefined {
  if (typeof value === "number") return value;
  if (typeof value === "string" && value.trim() !== "" && !Number.isNaN(Number(value))) {
    return Number(value);
  }
  return undefined;
}
