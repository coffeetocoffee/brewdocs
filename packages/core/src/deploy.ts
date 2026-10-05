import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { build, buildVersions, buildMulti } from "./build.js";
import { buildModel } from "./build.js";
import type { RenderOptions } from "./render.js";
import type { Source } from "./types.js";
import type { StorageAdapter } from "./deploy/storage.js";
import { recordOrgSite } from "./cloud.js";

/** A hosted site's visibility — private sites require a token to read. */
export type Visibility = "public" | "private";

/** Deploy options: visibility, access token, org and draft expiry. */
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
 *
 * @param source - source descriptor whose `name` or resolved `root` basename seeds the slug.
 * @param requested - explicit subdomain to slug instead of deriving one from `source`.
 * @returns the lowercased, DNS-safe subdomain slug (empty when the input yields no alphanumerics).
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
 *
 * @param org - org namespace to prefix, or undefined for a bare subdomain.
 * @param sub - site subdomain to slug and append.
 * @returns the combined `<org>--<sub>` slug, or just the slugged `sub` when no org is given.
 */
export function combineSubdomain(org: string | undefined, sub: string): string {
  const base = deriveSubdomain({ root: "", name: sub });
  if (!org) return base;
  return `${deriveSubdomain({ root: "", name: org })}--${base}`;
}

/** Outcome of a deploy: subdomain, written files and manifest facts. */
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
 *
 * @param source - docs source (root, name) to build from.
 * @param outDir - directory to write the static site into.
 * @param options - render options controlling theming, versions and multi-page output.
 * @returns the path of the main index.html written into `outDir`.
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
 *
 * @param source - docs source to build and deploy.
 * @param hostingDir - local hosting root that holds the deployed site directory and its manifest.
 * @param subdomain - subdomain slug the site is published under.
 * @param options - render options passed through to the builder.
 * @param storage - optional object-storage adapter; when set the build is uploaded instead of written under `hostingDir`.
 * @param deployOpts - deploy metadata: org namespace, visibility, access token, and draft/expiry settings.
 * @returns the deployed site's public URL, output directory, resolved visibility and org.
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

  // v2.5 cloud control plane: org-scoped deploys claim the site so org
  // members can read private docs and the org gets analytics rollups. S3
  // targets have no persistent local control plane, so skip the claim there.
  if (!storage && deployOpts.org) {
    recordOrgSite(hostingDir, deployOpts.org, subdomain);
  }

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
 *
 * @param hostingDir - local hosting root containing the site directory.
 * @param subdomain - subdomain of the site whose draft link is being changed.
 * @param expires - new ISO 8601 expiry, or null to revoke the draft flag entirely.
 * @returns true when the manifest was found and rewritten, false when missing or unreadable.
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

/**
 * Has a site's draft link expired? (Non-drafts never expire.)
 *
 * @param manifest - site manifest fields carrying the draft flag and its expiry.
 * @returns true when the manifest is a draft with a parseable expiry in the past.
 */
export function draftExpired(manifest: {
  draft?: boolean;
  draftExpires?: string;
}): boolean {
  if (!manifest.draft || !manifest.draftExpires) return false;
  const t = Date.parse(manifest.draftExpires);
  return !Number.isNaN(t) && Date.now() > t;
}
