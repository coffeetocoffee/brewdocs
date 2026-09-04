import { beforeAll, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { build, buildModel, type RenderModel } from "@brewdocs/core";
import { runNpm } from "./resolve.js";

/**
 * Phase 1 roadmap item: snapshot tests against real npm packages.
 * Covers small (ms), popular/TS (zod), hostile CJS (lodash), and a scoped
 * monorepo package (@babel/core).
 *
 * Versions are pinned so snapshots stay stable. Packages are fetched with
 * `npm pack` (tarball only — no dependency install), cached under the OS
 * temp dir, and skipped entirely when the network is unavailable.
 */

const PACKAGES = [
  { name: "ms", spec: "ms@2.1.3", label: "ms (small, CJS + JSDoc)" },
  { name: "zod", spec: "zod@3.23.8", label: "zod (popular, TS, exports map)" },
  {
    name: "lodash",
    spec: "lodash@4.17.21",
    label: "lodash (hostile: no types, 500KB single file)",
  },
  {
    name: "@babel/core",
    spec: "@babel/core@7.25.2",
    label: "@babel/core (scoped, monorepo origin, CJS named exports)",
  },
];

const CACHE = path.join(os.tmpdir(), "brewdocs-realworld");

function destFor(spec: string): string {
  return path.join(CACHE, spec.replace(/[@/]/g, "_"));
}

/** npm tarballs always extract to a top-level `package/` directory. */
function rootFor(spec: string): string {
  return path.join(destFor(spec), "package");
}

function fetchPackage(spec: string): void {
  const dest = destFor(spec);
  if (fs.existsSync(path.join(rootFor(spec), "package.json"))) return;
  fs.mkdirSync(dest, { recursive: true });
  const out = runNpm(["pack", spec, "--json", "--pack-destination", dest], {
    capture: true,
  });
  const info = JSON.parse(out);
  const tgz = path.join(dest, (Array.isArray(info) ? info[0] : info).filename);
  execFileSync("tar", ["-xzf", tgz, "-C", dest], { timeout: 60_000 });
  fs.rmSync(tgz, { force: true });
}

/** Compact, reviewable view of a model — README HTML is intentionally excluded. */
function summarize(model: RenderModel) {
  return {
    title: model.title,
    description: model.description,
    sectionTitles: model.sections.map((s) => s.title),
    pkg: model.pkg && {
      name: model.pkg.name,
      version: model.pkg.version,
      license: model.pkg.license,
      hasExportsMap: Boolean(model.pkg.exports),
    },
    symbols: model.symbols.map((s) => ({
      name: s.name,
      kind: s.kind,
      params: s.params.map((p) => `${p.name}: ${p.type ?? "?"}`),
      returns: s.returns?.type,
      deprecated: s.deprecated,
    })),
  };
}

describe("real-world packages (npm)", () => {
  let ready = false;

  beforeAll(() => {
    try {
      for (const { spec } of PACKAGES) fetchPackage(spec);
      ready = true;
    } catch {
      ready = false; // offline or npm/tar missing — skip rather than fail CI
    }
  }, 300_000);

  for (const { name, spec, label } of PACKAGES) {
    it(`extracts + builds ${label}`, (ctx) => {
      if (!ready) return ctx.skip();
      const root = rootFor(spec);
      const model = buildModel({ root, name });
      expect(summarize(model)).toMatchSnapshot();

      const out = fs.mkdtempSync(path.join(os.tmpdir(), "brewdocs-rw-"));
      const file = build({ root, name }, out);
      const html = fs.readFileSync(file, "utf8");
      expect(html).toContain("<!doctype html>");
    }, 180_000);
  }
});
