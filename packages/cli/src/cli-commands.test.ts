import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { run } from "./index.js";

describe("Authoring DX commands", () => {
  let cwd: string;
  let tmp: string;

  beforeEach(() => {
    cwd = process.cwd();
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "brewdocs-init-"));
    process.chdir(tmp);
  });

  afterEach(() => {
    process.chdir(cwd);
  });

  it("brewdocs init scaffolds a brewdocs.yml", async () => {
    await run(["init"]);
    const file = path.join(tmp, "brewdocs.yml");
    expect(fs.existsSync(file)).toBe(true);
    const text = fs.readFileSync(file, "utf8");
    expect(text).toContain("theme:");
    expect(text).toContain("dark:");
  });

  it("brewdocs init refuses to overwrite an existing config", async () => {
    await run(["init"]);
    await expect(run(["init"])).rejects.toThrow(/already exists/);
  });
});
