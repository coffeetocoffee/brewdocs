import * as fs from "node:fs";
import * as path from "node:path";
import type { ExtractResult, PackageInfo, Source } from "./types.js";
import { extractReadme } from "./extractors/readme.js";
import { extractPackage } from "./extractors/package.js";
import { extractExports } from "./extractors/exports.js";
import { resolveReplacements } from "./replacements.js";

const PKG_FILE = "package.json";
const README_FILES = ["README.md", "readme.md", "Readme.md"];

/**
 * Extract a doc model from a local source directory.
 *
 * Phase 1 pulls: package.json (structured), README (frontmatter + sections),
 * and exported symbols (with JSDoc/TSDoc) via the TypeScript compiler.
 */
export function extractFromSource(source: Source): ExtractResult {
  const root = source.root;
  let title = source.name ?? path.basename(path.resolve(root));
  let description: string | undefined;
  let metadata: Record<string, unknown> = {};
  let pkg: PackageInfo | undefined;

  const pkgPath = path.join(root, PKG_FILE);
  if (fs.existsSync(pkgPath)) {
    try {
      const parsed = JSON.parse(fs.readFileSync(pkgPath, "utf8"));
      metadata = parsed;
      pkg = extractPackage(parsed);
      if (typeof parsed.name === "string") title = parsed.name;
      if (typeof parsed.description === "string") description = parsed.description;
    } catch {
      // Malformed package.json: keep defaults, ignore metadata.
    }
  }

  let readme: ReturnType<typeof extractReadme> | undefined;
  const readmePath = README_FILES.map((f) => path.join(root, f)).find((p) =>
    fs.existsSync(p),
  );
  if (readmePath) {
    try {
      readme = extractReadme(fs.readFileSync(readmePath, "utf8"));
    } catch {
      readme = undefined;
    }
  }

  let symbols: import("./types.js").SymbolDoc[] = [];
  if (pkg) {
    try {
      symbols = extractExports(root, metadata);
    } catch (err) {
      // A weird/circular/broken module should never blow up the whole build.
      console.warn(
        `[brewdocs] skipping symbol extraction for "${title}": ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      symbols = [];
    }
  }

  // Direction C: resolve deprecation -> replacement links once, at the
  // source, so every surface (HTML, Markdown, artifact, diff) gets them.
  const replacements = resolveReplacements(symbols);
  for (const sym of symbols) {
    if (replacements[sym.name]) sym.replacements = replacements[sym.name];
  }

  return { title, description, readme, pkg, metadata, symbols };
}
