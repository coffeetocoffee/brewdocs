import * as fs from "node:fs";
import * as path from "node:path";
import { build, buildModel } from "./build.js";
import { analyzeSymbols, type DoctorReport } from "./doctor.js";
import { renderToHtml, type RenderOptions } from "./render.js";
import { gitShaOf } from "./git.js";
import type { RenderModel, Source } from "./types.js";

/** One package discovered inside a workspace. */
export interface WorkspacePackage {
  /** Package name from its package.json (falls back to dir basename). */
  name: string;
  /** Absolute path to the package directory. */
  root: string;
  /** Directory basename, used for output dirs and link slugs. */
  dir: string;
}

/**
 * Detect npm / yarn / pnpm workspaces from a root `package.json`.
 *
 * - npm + yarn 1: `"workspaces": ["packages/*"]`
 * - yarn 2+ / pnpm: `"workspaces": { "packages": [...] }`
 *
 * Returns member directories that contain a package.json, deduped and
 * sorted by name for deterministic builds.
 */
export function detectWorkspaces(root: string): WorkspacePackage[] {
  const rootPath = path.resolve(root);
  let globs: string[] = [];
  try {
    const pkg = JSON.parse(
      fs.readFileSync(path.join(rootPath, "package.json"), "utf8"),
    ) as { workspaces?: string[] | { packages?: string[] } };
    if (Array.isArray(pkg.workspaces)) {
      globs = pkg.workspaces;
    } else if (pkg.workspaces && Array.isArray(pkg.workspaces.packages)) {
      globs = pkg.workspaces.packages;
    }
  } catch {
    return [];
  }
  if (globs.length === 0) return [];

  const members: WorkspacePackage[] = [];
  for (const glob of globs) {
    for (const candidate of expandGlob(rootPath, glob)) {
      const pkgPath = path.join(candidate, "package.json");
      if (!fs.existsSync(pkgPath)) continue;
      let name = path.basename(candidate);
      try {
        const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8")) as {
          name?: string;
        };
        if (typeof pkg.name === "string" && pkg.name) name = pkg.name;
      } catch {
        /* fall back to dir name */
      }
      members.push({ name, root: candidate, dir: path.basename(candidate) });
    }
  }

  const seen = new Set<string>();
  return members
    .filter((m) => {
      if (seen.has(m.root)) return false;
      seen.add(m.root);
      return true;
    })
    .sort((a, b) => a.name.localeCompare(b.name));
}

/** Expand a `dir/*` glob (or a literal directory path) against the fs. */
function expandGlob(root: string, glob: string): string[] {
  const star = glob.indexOf("*");
  if (star === -1) {
    const one = path.resolve(root, glob);
    return fs.existsSync(one) ? [one] : [];
  }
  const base = glob.slice(0, star).replace(/[/\\]+$/, "");
  const baseDir = base ? path.resolve(root, base) : root;
  if (!fs.existsSync(baseDir)) return [];
  return fs
    .readdirSync(baseDir)
    .filter((entry) => {
      try {
        return fs.statSync(path.join(baseDir, entry)).isDirectory();
      } catch {
        return false;
      }
    })
    .map((entry) => path.join(baseDir, entry));
}

function escapeHtml(input: string): string {
  return input
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

/**
 * Cross-package link table for workspace mode: exported symbol name ->
 * href relative to the referencing member's output dir. Local symbols
 * resolve to in-page anchors by the renderer; only names another member
 * exports fall through to these targets.
 */
export function crossPackageLinks(
  members: WorkspacePackage[],
  models: Map<string, RenderModel>,
): Map<string, { symbol: string; package: string; dir: string }> {
  const map = new Map<string, { symbol: string; package: string; dir: string }>();
  for (const member of members) {
    const model = models.get(member.name);
    if (!model) continue;
    for (const symbol of model.symbols) {
      if (!map.has(symbol.name)) {
        map.set(symbol.name, {
          symbol: symbol.name,
          package: member.name,
          dir: member.dir,
        });
      }
    }
  }
  return map;
}

/**
 * Build the `externalLinks` map for one member: every cross-package symbol
 * (exported by a *different* member) pointing at `../<dir>/index.html#…`.
 * The docmodels are the source of truth — each member's `docmodel.json`
 * (already emitted by default) carries the exported symbol set, so a CI
 * job or editor can rebuild this table from artifacts alone.
 */
export function externalLinksFor(
  member: WorkspacePackage,
  cross: Map<string, { symbol: string; package: string; dir: string }>,
): Map<string, string> {
  const out = new Map<string, string>();
  for (const entry of cross.values()) {
    if (entry.package === member.name) continue;
    const anchor = entry.symbol
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "");
    out.set(entry.symbol, `../${entry.dir}/index.html#symbol-${anchor}`);
  }
  return out;
}

/** Rollup doctor report across workspace members. */
export interface WorkspaceRollup {
  packages: Array<{ name: string; dir: string; score: number; report: DoctorReport }>;
  /** Doctor score (same 60/20/10/10 weights) computed over workspace totals. */
  score: number;
}

/** Run `doctor` per package and compute a symbol-weighted rollup score. */
export function rollupCoverage(
  members: WorkspacePackage[],
  models: Map<string, RenderModel>,
): WorkspaceRollup {
  const packages: WorkspaceRollup["packages"] = [];
  let totalSymbols = 0;
  let documentedSymbols = 0;
  let paramsTotal = 0;
  let paramsDocumented = 0;
  let returnsTotal = 0;
  let returnsDocumented = 0;
  let runnableTotal = 0;
  let runnableWithExamples = 0;

  for (const member of members) {
    const model = models.get(member.name);
    if (!model) continue;
    const report = analyzeSymbols(model.title, model.symbols);
    packages.push({ name: member.name, dir: member.dir, score: report.score, report });
    totalSymbols += report.totalSymbols;
    documentedSymbols += report.documentedSymbols;
    paramsTotal += report.paramsTotal;
    paramsDocumented += report.paramsDocumented;
    returnsTotal += report.returnsTotal;
    returnsDocumented += report.returnsDocumented;
    for (const s of model.symbols) {
      if (s.kind === "function" || s.kind === "class") {
        runnableTotal++;
        if (s.examples.length > 0) runnableWithExamples++;
      }
    }
  }

  const docScore =
    totalSymbols === 0 ? 60 : (documentedSymbols / totalSymbols) * 60;
  const paramScore =
    paramsTotal === 0 ? 20 : (paramsDocumented / paramsTotal) * 20;
  const retScore =
    returnsTotal === 0 ? 10 : (returnsDocumented / returnsTotal) * 10;
  const exampleScore =
    runnableTotal === 0 ? 10 : (runnableWithExamples / runnableTotal) * 10;

  return {
    packages,
    score: Math.round(docScore + paramScore + retScore + exampleScore),
  };
}

/**
 * Build every workspace member into `<out>/<dir>/` (one site per package,
 * docmodel.json included) plus a root `index.html` listing them with the
 * rollup coverage chip. Cross-package type references between members are
 * linked. Returns the written index files.
 */
export function buildWorkspaces(
  source: Source,
  outDir: string,
  options: RenderOptions = {},
): string[] {
  const members = detectWorkspaces(source.root);
  if (members.length === 0) {
    throw new Error(
      `no workspaces found in ${source.root} (expected "workspaces" in package.json)`,
    );
  }

  fs.mkdirSync(outDir, { recursive: true });
  const models = new Map<string, RenderModel>();
  for (const member of members) {
    models.set(member.name, buildModel({ root: member.root, name: member.name }));
  }
  const cross = crossPackageLinks(members, models);

  const written: string[] = [];
  for (const member of members) {
    const file = build(
      { root: member.root, name: member.name },
      path.join(outDir, member.dir),
      { ...options, externalLinks: externalLinksFor(member, cross) },
    );
    written.push(file);
  }

  // Root index: list every member with its per-package coverage and the
  // workspace rollup score in the header chip.
  const rollup = rollupCoverage(members, models);
  const rows = members
    .map((m) => {
      const entry = rollup.packages.find((p) => p.name === m.name);
      const score = entry ? ` <span class="kind">${entry.score}%</span>` : "";
      const desc = models.get(m.name)?.description ?? "";
      return `<li><a href="./${escapeHtml(m.dir)}/index.html">${escapeHtml(
        m.name,
      )}</a>${score}${desc ? ` — ${escapeHtml(desc)}` : ""}</li>`;
    })
    .join("\n");

  const rootModel: RenderModel = {
    title: source.name ?? path.basename(path.resolve(source.root)),
    description: `Workspace docs — ${members.length} package${members.length === 1 ? "" : "s"}`,
    frontmatter: {},
    sections: [],
    metadata: {},
    symbols: [],
  };
  const rootHtml = renderToHtml(rootModel, {
    ...options,
    score: rollup.score,
    freshness: {
      gitSha: gitShaOf(source.root),
      generatedAt: new Date().toISOString(),
    },
  }).replace(
    /<main id="main-content">[\s\S]*?<\/main>/,
    `<main id="main-content"><section id="api"><h2>Packages</h2><ul class="symbol-index">${rows}</ul></section></main>`,
  );
  const rootFile = path.join(outDir, "index.html");
  fs.writeFileSync(rootFile, rootHtml, "utf8");
  written.push(rootFile);
  return written;
}
