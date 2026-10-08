import { describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { build, buildModel, buildMulti, exportSite } from "@brewdocs/core";

const EXAMPLES = path.resolve(process.cwd(), "examples");

function exampleDirs(): string[] {
  return fs
    .readdirSync(EXAMPLES)
    .map((name) => path.join(EXAMPLES, name))
    .filter(
      (p) =>
        fs.statSync(p).isDirectory() &&
        fs.existsSync(path.join(p, "package.json")),
    );
}

describe("fuzz: every example builds without throwing", () => {
  for (const dir of exampleDirs()) {
    const name = path.basename(dir);
    it(`builds ${name} (single + multi) and produces HTML`, async () => {
      const out = fs.mkdtempSync(path.join(os.tmpdir(), "brewdocs-fuzz-"));
      const single = build({ root: dir, name }, path.join(out, "single"));
      const multi = buildMulti({ root: dir, name }, path.join(out, "multi"));
      const html = fs.readFileSync(single, "utf8");
      const model = buildModel({ root: dir, name });

      expect(html).toContain("<!doctype html>");
      expect(html).toContain("BrewDocs");
      expect(multi.length).toBe(model.symbols.length + 1);
    });
  }

  // The heaviest test in the suite (a full exportSite of examples/lib, ~34s
  // solo). Under `npm run verify` it runs beside the server tests and the
  // gate's own test spawns, and on 2026-10-08 it crossed the 60s budget —
  // the same load-induced timeout class as finding #18, so it gets the same
  // treatment the api/deploy tests already carry: an explicit budget + retry.
  it(
    "exports a fully self-contained site without throwing",
    { timeout: 120_000, retry: 2 },
    async () => {
      const out = fs.mkdtempSync(path.join(os.tmpdir(), "brewdocs-fuzz-"));
      const file = await exportSite({ root: path.join(EXAMPLES, "lib"), name: "lib" }, out);
      const html = fs.readFileSync(file, "utf8");
      expect(html).toContain("<!doctype html>");
    },
  );
});
