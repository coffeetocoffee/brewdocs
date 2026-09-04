import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { execFileSync } from "node:child_process";
import { extractFromSource } from "./extract.js";
import { renderToHtml, type RenderOptions } from "./render.js";
import { discoverVersions } from "./versions.js";
import type { RenderModel, Source } from "./types.js";

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

function dirSafe(version: string): string {
  return version.replace(/[^a-zA-Z0-9._-]/g, "_");
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
  const root = source.root;
  const isGit = fs.existsSync(path.join(root, ".git"));
  let srcRoot = root;
  let cleanup: (() => void) | null = null;

  if (isGit && version !== pkgVersion(root)) {
    const tmp = await checkoutVersion(root, version);
    if (tmp) {
      srcRoot = tmp;
      cleanup = () => removeWorktree(root, tmp);
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

  const root = source.root;
  const isGit = fs.existsSync(path.join(root, ".git"));
  const built: string[] = [];

  for (const v of versions) {
    let srcRoot = root;
    let cleanup: (() => void) | null = null;
    if (isGit && v !== pkgVersion(root)) {
      const tmp = await checkoutVersion(root, v);
      if (!tmp) continue;
      srcRoot = tmp;
      cleanup = () => removeWorktree(root, tmp);
    }

    const model = buildModel({ root: srcRoot, name: source.name });
    const links = versions.map((o) => ({
      version: o,
      path: o === v ? "./index.html" : `../${dirSafe(o)}/index.html`,
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

  const latest = versions[0];
  const rootModel = buildModel({ root, name: source.name });
  const rootLinks = versions.map((o) => ({
    version: o,
    path: o === latest ? "./index.html" : `./${dirSafe(o)}/index.html`,
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
