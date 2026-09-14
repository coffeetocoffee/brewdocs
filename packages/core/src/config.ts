import * as fs from "node:fs";
import * as path from "node:path";

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
}

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
 */
export function loadConfig(root: string): BrewDocsConfig {
  const yamlPath = path.join(root, "brewdocs.yml");
  const jsonPath = path.join(root, "brewdocs.json");
  try {
    if (fs.existsSync(yamlPath)) {
      return parseSimpleYaml(fs.readFileSync(yamlPath, "utf8"));
    }
    if (fs.existsSync(jsonPath)) {
      return JSON.parse(fs.readFileSync(jsonPath, "utf8")) as BrewDocsConfig;
    }
  } catch {
    /* fall through to empty config */
  }
  return {};
}
