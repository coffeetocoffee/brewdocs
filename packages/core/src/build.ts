import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { execFileSync } from "node:child_process";
import { extractFromSource } from "./extract.js";
import { renderToHtml, renderToHtmlMulti, renderContentPages, type RenderOptions, type RenderedPage } from "./render.js";
import { diffSymbols, renderDiffHtml } from "./diff.js";
import { discoverVersions } from "./versions.js";
import { analyzeSymbols } from "./doctor.js";
import { renderDocModelJson } from "./docmodel.js";
import { gitShaOf } from "./git.js";
import { loadConfig } from "./config.js";
import { extractCached } from "./cache.js";
import { loadPlugins, type BrewDocsPlugin } from "./plugins.js";
import { loadContent, loadNav } from "./content.js";
import { loadThemeManifest, manifestSlots, type Slots } from "./theme-manifest.js";
import {
  dirSafe,
  emitAliasPages,
  emitRedirects,
  isEolVersion,
} from "./aliases.js";
import type { ExtractResult, RenderModel, Source } from "./types.js";

/**
 * v2.0 per-source setup shared by build/buildModel/buildMulti: loads
 * plugins (brewdocs.yml + CLI), resolves the theme manifest (name, base,
 * slot partials), attaches content/nav, and threads everything into
 * RenderOptions.
 */
function resolveSetup(source: Source, options: RenderOptions): RenderOptions {
  if (options.plugins && options.slots && options.root) return options;
  const root = path.resolve(source.root);
  const config = loadConfig(root);
  // v3.0: plugin names that aren't paths/npm-resolvable fall back to the
  // registry (brewdocs.yml `registry:`, relative to the source, or env).
  const registryDir = config.registry
    ? path.resolve(root, config.registry)
    : process.env.BREWDOCS_REGISTRY
      ? path.resolve(process.env.BREWDOCS_REGISTRY)
      : undefined;
  const plugins: BrewDocsPlugin[] = [
    ...(options.plugins ?? []),
    ...loadPlugins(config.plugins, root, registryDir),
  ];
  const themeRef = options.theme ?? config.theme;
  const manifest = themeRef ? loadThemeManifest(themeRef, root) : null;
  const slots: Slots = options.slots ?? (() => {
    const merged: Slots = { ...manifestSlots(manifest ?? undefined) };
    for (const p of plugins) if (p.theme?.slots) Object.assign(merged, p.theme.slots);
    return merged;
  })();
  return {
    ...options,
    // Keep the *original* ref (may be a manifest name); themeFromRef resolves
    // base + vars + css at render time. Overwriting with manifest.extends here
    // would silently drop the manifest's own customizations.
    theme: themeRef ?? options.theme,
    // v3.0: brewdocs.yml `locale:` is the default; an explicit option wins.
    locale: options.locale ?? config.locale,
    plugins,
    slots,
    root,
  };
}

/** Fresh extraction honoring v2.0 setup: adapters, hooks, incremental cache. */
function extractForBuild(source: Source, options: RenderOptions): ExtractResult {
  return extractCached(source, {
    enabled: options.cache,
    plugins: options.plugins,
  });
}

/** Attach v2.0 content pages + nav to a render model. */
function attachContent(model: RenderModel, source: Source, options: RenderOptions): RenderModel {
  if (model.content || options.content === false) return model;
  const root = options.root ?? path.resolve(source.root);
  const content = loadContent(root);
  const nav = loadNav(root);
  if (content.length === 0 && !nav) return model;
  return { ...model, content, nav };
}

/** Freshness stamp for every artifact this build writes (Direction C). */
function freshness(source: Source): { gitSha?: string; generatedAt: string } {
  return { gitSha: gitShaOf(source.root), generatedAt: new Date().toISOString() };
}

/**
 * C.5: every brewed site ships its data artifact (`docmodel.json`) next to
 * the HTML unless the caller opts out (`emitDocmodel: false`).
 */
function emitDocModelArtifact(
  model: RenderModel,
  outDir: string,
  fresh: { gitSha?: string; generatedAt: string },
): void {
  fs.writeFileSync(
    path.join(outDir, "docmodel.json"),
    renderDocModelJson(model, {
      generatedAt: fresh.generatedAt,
      gitSha: fresh.gitSha,
    }),
    "utf8",
  );
}

/** Build the render model (no file write). Useful for tests/snapshots. */
export function buildModel(
  source: Source,
  options: RenderOptions = {},
): RenderModel {
  const resolved = resolveSetup(source, options);
  const extracted = extractForBuild(source, resolved);

  const model: RenderModel = {
    title: extracted.title,
    description: extracted.description,
    frontmatter: extracted.readme?.frontmatter ?? {},
    sections: extracted.readme?.sections ?? [],
    readmeHtml: extracted.readme?.html,
    metadata: extracted.metadata,
    pkg: extracted.pkg,
    symbols: extracted.symbols,
  };
  return attachContent(model, source, resolved);
}

/** Coverage score (0–100) for the rendered header chip. */
function coverageScore(model: RenderModel): number {
  try {
    return analyzeSymbols(model.title, model.symbols).score;
  } catch {
    return 0;
  }
}

/**
 * Orchestrate the Phase 2 pipeline:
 *   extract -> model -> render (theme) -> write index.html
 *
 * Returns the path to the written HTML file.
 */
export function build(
  source: Source,
  outDir: string,
  options: RenderOptions = {},
): string {
  const resolved = resolveSetup(source, options);
  const model = buildModel(source, resolved);
  const fresh = freshness(source);
  const html = renderToHtml(model, {
    ...resolved,
    score: coverageScore(model),
    freshness: fresh,
  });
  fs.mkdirSync(outDir, { recursive: true });
  const outFile = path.join(outDir, "index.html");
  fs.writeFileSync(outFile, html, "utf8");
  for (const page of renderContentPages(model, resolved)) {
    const target = path.join(outDir, page.path);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, page.html, "utf8");
  }
  // v3.0: moved pages keep answering — redirects from brewdocs.yml.
  emitRedirects(outDir, loadConfig(source.root).redirects);
  if (resolved.emitDocmodel !== false) {
    emitDocModelArtifact(model, outDir, fresh);
  }
  return outFile;
}

/** Walk up from `start` to locate the enclosing git repo root, if any. */
export function findGitRoot(start: string): string | null {
  let dir = path.resolve(start);
  for (;;) {
    if (fs.existsSync(path.join(dir, ".git"))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

/**
 * Extract the DocModel for a specific version (git tag) of a source.
 * Falls back to the working tree when the checkout fails — unless
 * `opts.strict`, which throws instead (used by CI so a bogus empty diff
 * can't pass silently).
 */
export async function extractVersion(
  source: Source,
  version: string,
  opts: { strict?: boolean; plugins?: BrewDocsPlugin[] } = {},
): Promise<ExtractResult> {
  const root = path.resolve(source.root);
  const gitRoot = findGitRoot(root);
  if (opts.strict && !gitRoot) {
    throw new Error(
      `"${root}" is not inside a git repository; cannot extract version "${version}"`,
    );
  }
  let srcRoot = root;
  let cleanup: (() => void) | null = null;

  if (gitRoot) {
    const tmp = await checkoutVersion(gitRoot, version);
    if (tmp) {
      // The source may live in a subdirectory of the repo (monorepo).
      const rel = path.relative(gitRoot, root);
      srcRoot = rel ? path.join(tmp, rel) : tmp;
      cleanup = () => removeWorktree(gitRoot, tmp);
    } else if (opts.strict) {
      throw new Error(
        `could not check out "${version}" — is the ref fetched in this clone?`,
      );
    }
  }

  try {
    return extractFromSource({ root: srcRoot, name: source.name }, opts.plugins ?? []);
  } finally {
    if (cleanup) cleanup();
  }
}

/**
 * Build the render model into multiple HTML files: `index.html` plus one
 * `symbols/<slug>.html` per exported symbol. Returns the written file paths.
 */
export function buildMulti(
  source: Source,
  outDir: string,
  options: RenderOptions = {},
): string[] {
  const resolved = resolveSetup(source, options);
  const model = buildModel(source, resolved);
  const fresh = freshness(source);
  const pages: RenderedPage[] = [
    ...renderToHtmlMulti(model, {
      ...resolved,
      multiPage: true,
      score: coverageScore(model),
      freshness: fresh,
    }),
    ...renderContentPages(model, { ...resolved, freshness: fresh }),
  ];
  fs.mkdirSync(outDir, { recursive: true });
  const written: string[] = [];
  for (const page of pages) {
    const outFile = path.join(outDir, page.path);
    fs.mkdirSync(path.dirname(outFile), { recursive: true });
    fs.writeFileSync(outFile, page.html, "utf8");
    written.push(outFile);
  }
  if (resolved.emitDocmodel !== false) {
    emitDocModelArtifact(model, outDir, fresh);
  }
  return written;
}

function pkgVersion(root: string): string {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
    if (typeof pkg.version === "string") return pkg.version;
  } catch {
    /* ignore */
  }
  return "dev";
}

/** Checkout a git ref into a temp worktree; returns the path or null on failure. */
async function checkoutVersion(root: string, ref: string): Promise<string | null> {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "brewdocs-v-"));
  fs.rmSync(tmp, { recursive: true, force: true });
  try {
    execFileSync("git", ["worktree", "add", "--detach", tmp, ref], {
      cwd: root,
      stdio: "ignore",
    });
    return tmp;
  } catch {
    try {
      fs.rmSync(tmp, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
    return null;
  }
}

function removeWorktree(root: string, tmp: string): void {
  try {
    execFileSync("git", ["worktree", "remove", "--force", tmp], {
      cwd: root,
      stdio: "ignore",
    });
  } catch {
    /* ignore */
  }
  try {
    fs.rmSync(tmp, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
}

/**
 * Build a single specific version (e.g. a git tag) into `outDir/index.html`.
 * Without git it falls back to building the working tree.
 */
export async function buildVersion(
  source: Source,
  outDir: string,
  version: string,
  options: RenderOptions = {},
): Promise<string> {
  const root = path.resolve(source.root);
  const gitRoot = findGitRoot(root);
  let srcRoot = root;
  let cleanup: (() => void) | null = null;

  if (gitRoot && version !== pkgVersion(root)) {
    const tmp = await checkoutVersion(gitRoot, version);
    if (tmp) {
      const rel = path.relative(gitRoot, root);
      srcRoot = rel ? path.join(tmp, rel) : tmp;
      cleanup = () => removeWorktree(gitRoot, tmp);
    }
  }

  const file = build(
    { root: srcRoot, name: source.name },
    outDir,
    {
      ...options,
      currentVersion: version,
      versions: [{ version, path: "./index.html" }],
    },
  );
  if (cleanup) cleanup();
  return file;
}

/**
 * Build every discovered version into `outDir/<version>/index.html` plus a root
 * `outDir/index.html` for the latest version. The version switcher links
 * between them. Without git only the current version is built.
 */
export async function buildVersions(
  source: Source,
  outDir: string,
  options: RenderOptions = {},
): Promise<string[]> {
  const versions = await discoverVersions(source.root);
  // v3.0: EOL list + aliases/redirects live in brewdocs.yml.
  const config = loadConfig(path.resolve(source.root));
  const eolList = config.eol;
  // Per-version builds run in throwaway worktrees; the extraction cache
  // belongs to the working tree only.
  const singleOptions = { ...options, cache: false };

  if (versions.length <= 1) {
    return [
      build(source, outDir, {
        ...options,
        currentVersion: versions[0],
        eol: isEolVersion(versions[0], eolList),
        versions: versions.map((v) => ({
          version: v,
          path: "./index.html",
          eol: isEolVersion(v, eolList),
        })),
      }),
    ];
  }

  const root = path.resolve(source.root);
  const gitRoot = findGitRoot(root);
  const built: string[] = [];
  const models = new Map<string, RenderModel>();

  for (const v of versions) {
    let srcRoot = root;
    let cleanup: (() => void) | null = null;
    if (gitRoot && v !== pkgVersion(root)) {
      const tmp = await checkoutVersion(gitRoot, v);
      if (!tmp) continue;
      const rel = path.relative(gitRoot, root);
      srcRoot = rel ? path.join(tmp, rel) : tmp;
      cleanup = () => removeWorktree(gitRoot, tmp);
    }

    const model = buildModel({ root: srcRoot, name: source.name }, singleOptions);
    models.set(v, model);
    const links = versions.map((o) => ({
      version: o,
      path: o === v ? "./index.html" : `../${dirSafe(o)}/index.html`,
      diffPath: models.has(o) && versions.indexOf(o) < versions.length - 1
        ? `../${dirSafe(o)}/diff.html`
        : undefined,
      eol: isEolVersion(o, eolList),
    }));
    const fresh = freshness({ root: srcRoot, name: source.name });
    const html = renderToHtml(model, {
      ...singleOptions,
      versions: links,
      currentVersion: v,
      eol: isEolVersion(v, eolList),
      locale: singleOptions.locale ?? config.locale,
      score: coverageScore(model),
      freshness: fresh,
    });

    const vdir = path.join(outDir, dirSafe(v));
    fs.mkdirSync(vdir, { recursive: true });
    const outFile = path.join(vdir, "index.html");
    fs.writeFileSync(outFile, html, "utf8");
    built.push(outFile);
    if (options.emitDocmodel !== false) {
      emitDocModelArtifact(model, vdir, fresh);
    }
    if (cleanup) cleanup();
  }

  // API diff pages between consecutive versions, newest vs previous.
  const ordered = versions.filter((v) => models.has(v));
  for (let i = 0; i < ordered.length - 1; i++) {
    const newer = models.get(ordered[i])!;
    const older = models.get(ordered[i + 1])!;
    const diff = diffSymbols(ordered[i + 1], older.symbols, ordered[i], newer.symbols);
    if (diff.added.length + diff.removed.length + diff.changed.length === 0) continue;
    const diffHtml = renderDiffHtml(diff, newer.title);
    const diffFile = path.join(outDir, dirSafe(ordered[i]), "diff.html");
    fs.mkdirSync(path.dirname(diffFile), { recursive: true });
    fs.writeFileSync(diffFile, diffHtml, "utf8");
    built.push(diffFile);
  }

  const latest = versions[0];
  const rootModel = models.get(latest) ?? buildModel({ root, name: source.name }, options);
  const rootLinks = versions.map((o) => ({
    version: o,
    path: o === latest ? "./index.html" : `./${dirSafe(o)}/index.html`,
    diffPath: models.has(o) && versions.indexOf(o) < versions.length - 1
      ? `./${dirSafe(o)}/diff.html`
      : undefined,
    eol: isEolVersion(o, eolList),
  }));
  const rootFile = path.join(outDir, "index.html");
  const rootFresh = freshness({ root, name: source.name });
  fs.writeFileSync(
    rootFile,
    renderToHtml(rootModel, {
      ...options,
      versions: rootLinks,
      currentVersion: latest,
      eol: isEolVersion(latest, eolList),
      locale: options.locale ?? config.locale,
      score: coverageScore(rootModel),
      freshness: rootFresh,
    }),
    "utf8",
  );
  if (options.emitDocmodel !== false) {
    emitDocModelArtifact(rootModel, outDir, rootFresh);
  }
  // v3.0: alias pages (`/latest/` etc.) + moved-page redirects.
  built.push(...emitAliasPages(outDir, versions, config.aliases, { eol: eolList }));
  built.push(...emitRedirects(outDir, config.redirects));
  return [rootFile, ...built];
}
