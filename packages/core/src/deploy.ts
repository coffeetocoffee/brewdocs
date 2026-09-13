import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { build, buildVersions, buildMulti } from "./build.js";
import { buildModel } from "./build.js";
import type { RenderOptions } from "./render.js";
import type { Source } from "./types.js";
import type { StorageAdapter } from "./deploy/storage.js";

/** A hosted site's visibility — private sites require a token to read. */
export type Visibility = "public" | "private";

export interface DeploySiteOptions {
  /** Org namespace; combined into the subdomain as `<org>--<sub>`. */
  org?: string;
  /** Public (default) or private (token-gated at read time). */
  visibility?: Visibility;
  /** Plaintext access token for private sites; hashed before storage. */
  token?: string;
  /**
   * v1.2 private drafts: deploy as a time-limited draft link. `draftExpires`
   * (ISO 8601) sets the expiry recorded in the manifest.
   */
  draft?: boolean;
  draftExpires?: string;
}

/** GitHub repo URLs (`github.com/user/repo[.git]`) matched here. */
const GITHUB_RE = /github\.com[/:]([^/]+)\/([^/#?.\s]+)/i;

/**
 * Turn a source name/path into a safe subdomain slug. GitHub URLs collapse to
 * the `repo-user` form (e.g. `github.com/user/repo` -> `repo-user`) so the
 * hosted URL mirrors the source repo, per the roadmap.
 */
export function deriveSubdomain(source: Source, requested?: string): string {
  let base = requested ?? source.name ?? path.basename(path.resolve(source.root));
  const gh = GITHUB_RE.exec(base);
  if (gh) {
    const user = gh[1];
    const repo = gh[2].replace(/\.git$/i, "");
    base = `${repo}-${user}`;
  }
  return base
    .toLowerCase()
    .replace(/^@/, "")
    .replace(/\//g, "-")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/**
 * Combine an optional org namespace with a subdomain. Org-scoped sites become
 * `<org>--<sub>` so multi-tenant hosting stays in a flat directory layout
 * (e.g. `acme--my-lib.brewdocs.dev`).
 */
export function combineSubdomain(org: string | undefined, sub: string): string {
  const base = deriveSubdomain({ root: "", name: sub });
  if (!org) return base;
  return `${deriveSubdomain({ root: "", name: org })}--${base}`;
}

export interface DeployResult {
  url: string;
  dir: string;
  /** Echoed back for CLI output. */
  visibility?: Visibility;
  org?: string;
}

const HOST_SUFFIX = "brewdocs.dev";

function sha256(value: string): string {
  return crypto.createHash("sha256").update(value).digest("hex");
}

/**
 * Static export: build a fully self-contained site (HTML + inline CSS/JS +
 * search index) into `outDir`. Returns the main index.html path.
 */
export async function exportSite(
  source: Source,
  outDir: string,
  options: RenderOptions = {},
): Promise<string> {
  const files = await buildVersions(source, outDir, options);
  return files[0];
}

/**
 * "Deploy" a site under a subdomain. With no `storage` adapter it writes to a
 * local hosting directory (simulated `*.brewdocs.dev`). Pass an
 * `S3StorageAdapter` to deploy to real object storage instead.
 */
export async function deploySite(
  source: Source,
  hostingDir: string,
  subdomain: string,
  options: RenderOptions = {},
  storage?: StorageAdapter,
  deployOpts: DeploySiteOptions = {},
): Promise<DeployResult> {
  const useTmp = Boolean(storage);
  const dir = useTmp
    ? fs.mkdtempSync(path.join(os.tmpdir(), "brewdocs-deploy-"))
    : path.join(hostingDir, subdomain);
  fs.mkdirSync(dir, { recursive: true });
  const files = options.multiPage
    ? buildMulti(source, dir, options)
    : await buildVersions(source, dir, options);

  const visibility: Visibility = deployOpts.visibility ?? "public";
  const tokenHash = deployOpts.token ? sha256(deployOpts.token) : undefined;
  const isDraft = Boolean(deployOpts.draft);
  if (isDraft && visibility !== "private") {
    throw new Error("--draft requires --private (draft links are token-gated)");
  }

  if (storage) {
    await storage.deploy(dir, subdomain);
    return {
      url: storage.urlFor(subdomain),
      dir,
      visibility,
      org: deployOpts.org,
    };
  }

  const model = buildModel(source);
  const manifest = {
    subdomain,
    org: deployOpts.org,
    visibility,
    tokenHash,
    draft: isDraft || undefined,
    draftExpires: isDraft ? deployOpts.draftExpires : undefined,
    url: `https://${subdomain}.${HOST_SUFFIX}`,
    title: model.title,
    generatedAt: new Date().toISOString(),
    pages: files.length,
  };
  fs.writeFileSync(
    path.join(dir, ".brewdocs.json"),
    JSON.stringify(manifest, null, 2),
    "utf8",
  );

  return {
    url: `https://${subdomain}.${HOST_SUFFIX}`,
    dir,
    visibility,
    org: deployOpts.org,
  };
}

/**
 * v1.2 private drafts: expire/extend a draft's link. Updates the site
 * manifest's `draftExpires`; passing `null` revokes the draft (the site
 * stays private but the draft flag and its expiry are cleared).
 * Returns true when the manifest was updated.
 */
export function setDraftExpiry(
  hostingDir: string,
  subdomain: string,
  expires: string | null,
): boolean {
  const manifestPath = path.join(hostingDir, subdomain, ".brewdocs.json");
  if (!fs.existsSync(manifestPath)) return false;
  try {
    const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8")) as {
      draft?: boolean;
      draftExpires?: string;
    };
    if (expires === null) {
      delete manifest.draft;
      delete manifest.draftExpires;
    } else {
      manifest.draft = true;
      manifest.draftExpires = expires;
    }
    fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), "utf8");
    return true;
  } catch {
    return false;
  }
}

/** Has a site's draft link expired? (Non-drafts never expire.) */
export function draftExpired(manifest: {
  draft?: boolean;
  draftExpires?: string;
}): boolean {
  if (!manifest.draft || !manifest.draftExpires) return false;
  const t = Date.parse(manifest.draftExpires);
  return !Number.isNaN(t) && Date.now() > t;
}
