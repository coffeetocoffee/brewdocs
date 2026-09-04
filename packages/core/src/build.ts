import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { execFileSync } from "node:child_process";
import { extractFromSource } from "./extract.js";
import { renderToHtml, renderToHtmlMulti, type RenderOptions } from "./render.js";
import { diffSymbols, renderDiffHtml } from "./diff.js";
import { discoverVersions } from "./versions.js";
import type { ExtractResult, RenderModel, Source } from "./types.js";

/** Build the render model (no file write). Useful for tests/snapshots. */
export function buildModel(source: Source): RenderModel {
  const extracted = extractFromSource(source);

  return {
    title: extracted.title,
    description: extracted.description,
    frontmatter: extracted.readme?.frontmatter ?? {},
    sections: extracted.readme?.sections ?? [],
    readmeHtml: extracted.readme?.html,
    metadata: extracted.metadata,
    pkg: extracted.pkg,
    symbols: extracted.symbols,
  };
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
  const model = buildModel(source);
  const html = renderToHtml(model, options);
  fs.mkdirSync(outDir, { recursive: true });
  const outFile = path.join(outDir, "index.html");
  fs.writeFileSync(outFile, html, "utf8");
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
  opts: { strict?: boolean } = {},
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
    return extractFromSource({ root: srcRoot, name: source.name });
  } finally {
    if (cleanup) cleanup();
  }
}

function dirSafe(version: string): string {
  return version.replace(/[^a-zA-Z0-9._-]/g, "_");
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
  const model = buildModel(source);
  const pages = renderToHtmlMulti(model, options);
  fs.mkdirSync(outDir, { recursive: true });
  const written: string[] = [];
  for (const page of pages) {
    const outFile = path.join(outDir, page.path);
    fs.mkdirSync(path.dirname(outFile), { recursive: true });
    fs.writeFileSync(outFile, page.html, "utf8");
    written.push(outFile);
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

  if (versions.length <= 1) {
    return [
      build(source, outDir, {
        ...options,
        currentVersion: versions[0],
        versions: versions.map((v) => ({ version: v, path: "./index.html" })),
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

    const model = buildModel({ root: srcRoot, name: source.name });
    models.set(v, model);
    const links = versions.map((o) => ({
      version: o,
      path: o === v ? "./index.html" : `../${dirSafe(o)}/index.html`,
      diffPath: models.has(o) && versions.indexOf(o) < versions.length - 1
        ? `../${dirSafe(o)}/diff.html`
        : undefined,
    }));
    const html = renderToHtml(model, {
      ...options,
      versions: links,
      currentVersion: v,
    });

    const vdir = path.join(outDir, dirSafe(v));
    fs.mkdirSync(vdir, { recursive: true });
    const outFile = path.join(vdir, "index.html");
    fs.writeFileSync(outFile, html, "utf8");
    built.push(outFile);
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
  const rootModel = models.get(latest) ?? buildModel({ root, name: source.name });
  const rootLinks = versions.map((o) => ({
    version: o,
    path: o === latest ? "./index.html" : `./${dirSafe(o)}/index.html`,
    diffPath: models.has(o) && versions.indexOf(o) < versions.length - 1
      ? `./${dirSafe(o)}/diff.html`
      : undefined,
  }));
  const rootFile = path.join(outDir, "index.html");
  fs.writeFileSync(
    rootFile,
    renderToHtml(rootModel, {
      ...options,
      versions: rootLinks,
      currentVersion: latest,
    }),
    "utf8",
  );
  return [rootFile, ...built];
}
