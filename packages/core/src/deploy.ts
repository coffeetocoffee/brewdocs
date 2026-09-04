import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { build, buildVersions, buildMulti } from "./build.js";
import { buildModel } from "./build.js";
import type { RenderOptions } from "./render.js";
import type { Source } from "./types.js";
import type { StorageAdapter } from "./deploy/storage.js";

/** Turn a source name/path into a safe subdomain slug. */
export function deriveSubdomain(source: Source): string {
  const base = source.name ?? path.basename(path.resolve(source.root));
  return base
    .toLowerCase()
    .replace(/^@/, "")
    .replace(/\//g, "-")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

export interface DeployResult {
  url: string;
  dir: string;
}

const HOST_SUFFIX = "brewdocs.dev";

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
): Promise<DeployResult> {
  const useTmp = Boolean(storage);
  const dir = useTmp
    ? fs.mkdtempSync(path.join(os.tmpdir(), "brewdocs-deploy-"))
    : path.join(hostingDir, subdomain);
  fs.mkdirSync(dir, { recursive: true });
  const files = options.multiPage
    ? buildMulti(source, dir, options)
    : await buildVersions(source, dir, options);

  if (storage) {
    await storage.deploy(dir, subdomain);
    return { url: storage.urlFor(subdomain), dir };
  }

  const model = buildModel(source);
  const manifest = {
    subdomain,
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

  return { url: `https://${subdomain}.${HOST_SUFFIX}`, dir };
}
