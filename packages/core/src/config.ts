import * as fs from "node:fs";
import * as path from "node:path";

export interface BrewDocsConfig {
  theme?: string;
  dark?: boolean;
  name?: string;
  multi?: boolean;
  storage?: "local" | "s3";
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

/**
 * Minimal YAML reader: supports top-level `key: value` pairs and a single
 * nested `s3:` block. Enough for brewdocs.yml without pulling in a YAML dep.
 */
function parseSimpleYaml(text: string): BrewDocsConfig {
  const cfg: BrewDocsConfig = {};
  const lines = text.split(/\r?\n/);
  let section: "s3" | null = null;
  for (const line of lines) {
    if (!line.trim() || line.trim().startsWith("#")) continue;
    const m = line.match(/^(\s*)([\w-]+):\s*(.*)$/);
    if (!m) continue;
    const indent = m[1].length;
    const key = m[2];
    const val = m[3];
    if (indent === 0) {
      if (key === "s3") {
        section = "s3";
        cfg.s3 = {};
        continue;
      }
      section = null;
      (cfg as Record<string, unknown>)[key] = val ? parseScalar(val) : true;
    } else if (section === "s3" && cfg.s3) {
      (cfg.s3 as Record<string, string>)[key] = String(parseScalar(val));
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
