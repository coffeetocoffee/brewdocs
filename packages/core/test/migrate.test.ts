import { describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  CURRENT_CONFIG_VERSION,
  loadConfig,
  migrateConfig,
  renderMigrateText,
} from "@brewdocs/core";

function tmp(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "brewdocs-migrate-"));
}

describe("v4.4 configVersion + migrate", () => {
  it("dry-runs by default, then stamps configVersion preserving comments", () => {
    const dir = tmp();
    const file = path.join(dir, "brewdocs.yml");
    fs.writeFileSync(file, "# my config\ntheme: ink\n");
    const dry = migrateConfig(dir);
    expect(dry).toMatchObject({ changed: true, wrote: false, from: 1, to: CURRENT_CONFIG_VERSION });
    expect(fs.readFileSync(file, "utf8")).not.toContain("configVersion");
    expect(renderMigrateText(dry!)).toMatch(/Would migrate/);

    const applied = migrateConfig(dir, { write: true });
    expect(applied!.wrote).toBe(true);
    const text = fs.readFileSync(file, "utf8");
    expect(text).toContain(`configVersion: ${CURRENT_CONFIG_VERSION}`);
    expect(text).toContain("# my config");
  });

  it("is idempotent once stamped", () => {
    const dir = tmp();
    fs.writeFileSync(
      path.join(dir, "brewdocs.yml"),
      `configVersion: ${CURRENT_CONFIG_VERSION}\ntheme: ink\n`,
    );
    const r = migrateConfig(dir, { write: true });
    expect(r).toMatchObject({ changed: false, from: CURRENT_CONFIG_VERSION });
    expect(renderMigrateText(r!)).toMatch(/nothing to do/);
  });

  it("loadConfig reads configVersion as a number and stays quiet at the current version", () => {
    const dir = tmp();
    fs.writeFileSync(
      path.join(dir, "brewdocs.yml"),
      `configVersion: ${CURRENT_CONFIG_VERSION}\ntheme: ink\n`,
    );
    expect(loadConfig(dir).configVersion).toBe(CURRENT_CONFIG_VERSION);
  });

  it("returns null when there is no config to migrate", () => {
    expect(migrateConfig(tmp())).toBeNull();
  });
});
