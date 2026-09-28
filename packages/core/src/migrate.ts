import * as fs from "node:fs";
import * as path from "node:path";
import { CURRENT_CONFIG_VERSION } from "./config.js";

/**
 * Upgrade `brewdocs.yml` / `brewdocs.json` to the current config format.
 *
 * The format has only ever grown additively, so migration is deliberately
 * small: stamp `configVersion`. It is a dry run unless `write` is set, and the
 * YAML path is a textual insert so comments and formatting survive (the
 * mini-YAML reader does not round-trip comments).
 */
export interface MigrateResult {
  file: string;
  format: "yml" | "json";
  from: number;
  to: number;
  changed: boolean;
  wrote: boolean;
  notes: string[];
}

export function migrateConfig(root: string, opts: { write?: boolean } = {}): MigrateResult | null {
  const yml = path.join(root, "brewdocs.yml");
  const json = path.join(root, "brewdocs.json");
  const file = fs.existsSync(yml) ? yml : fs.existsSync(json) ? json : null;
  if (!file) return null;
  const format: MigrateResult["format"] = file.endsWith(".json") ? "json" : "yml";
  const text = fs.readFileSync(file, "utf8");
  const notes: string[] = [];
  const base = { file, format, to: CURRENT_CONFIG_VERSION, notes };

  if (format === "json") {
    let data: Record<string, unknown>;
    try {
      data = JSON.parse(text) as Record<string, unknown>;
    } catch {
      notes.push("could not parse JSON — left as-is");
      return { ...base, from: 0, changed: false, wrote: false };
    }
    const from = typeof data.configVersion === "number" ? data.configVersion : 1;
    if (from >= CURRENT_CONFIG_VERSION) return { ...base, from, changed: false, wrote: false };
    if (opts.write) {
      fs.writeFileSync(
        file,
        JSON.stringify({ configVersion: CURRENT_CONFIG_VERSION, ...data }, null, 2) + "\n",
        "utf8",
      );
    }
    return { ...base, from, changed: true, wrote: Boolean(opts.write) };
  }

  const existing = /^configVersion:\s*(\d+)\s*$/m.exec(text);
  if (existing) {
    const from = Number(existing[1]);
    if (from === CURRENT_CONFIG_VERSION) return { ...base, from, changed: false, wrote: false };
    if (opts.write) {
      fs.writeFileSync(
        file,
        text.replace(/^configVersion:\s*\d+\s*$/m, `configVersion: ${CURRENT_CONFIG_VERSION}`),
        "utf8",
      );
    }
    return { ...base, from, changed: true, wrote: Boolean(opts.write) };
  }
  if (opts.write) {
    fs.writeFileSync(file, `configVersion: ${CURRENT_CONFIG_VERSION}\n${text}`, "utf8");
  }
  return { ...base, from: 1, changed: true, wrote: Boolean(opts.write) };
}

/** Human-readable one-line summary for the CLI. */
export function renderMigrateText(result: MigrateResult): string {
  const where = path.basename(result.file);
  if (!result.changed) return `${where} is already at configVersion ${result.to} — nothing to do.`;
  const verb = result.wrote ? "Migrated" : "Would migrate";
  return `${verb} ${where}: configVersion ${result.from} -> ${result.to}${result.wrote ? "" : " (dry run — pass --write)"}`;
}
