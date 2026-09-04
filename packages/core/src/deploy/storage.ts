import * as fs from "node:fs";
import * as path from "node:path";

const CONTENT_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".txt": "text/plain; charset=utf-8",
};

/** A backend that can host a built site under a subdomain. */
export interface StorageAdapter {
  /** Upload everything in `siteDir` so it is served at `subdomain`. */
  deploy(siteDir: string, subdomain: string): Promise<void>;
  /** Public URL for a deployed subdomain. */
  urlFor(subdomain: string): string;
}

export interface LocalStorageOptions {
  baseDir: string;
}

/** Writes the site into `<baseDir>/<subdomain>/` (the default, offline backend). */
export class LocalStorageAdapter implements StorageAdapter {
  constructor(private opts: LocalStorageOptions) {}

  async deploy(siteDir: string, subdomain: string): Promise<void> {
    const dest = path.join(this.opts.baseDir, subdomain);
    fs.mkdirSync(dest, { recursive: true });
    copyTree(siteDir, dest);
  }

  urlFor(subdomain: string): string {
    return `https://${subdomain}.brewdocs.dev`;
  }
}

export interface S3Options {
  bucket?: string;
  region?: string;
  endpoint?: string;
  accessKeyId?: string;
  secretAccessKey?: string;
  /** Domain that serves the bucket, e.g. `brewdocs.dev` -> <sub>.brewdocs.dev */
  publicDomain?: string;
}

/**
 * S3-compatible storage (AWS S3 or Cloudflare R2). Uses `@aws-sdk/client-s3`
 * via dynamic import so the dependency is only needed when this backend is
 * actually selected — the local flow stays dependency-free.
 */
export class S3StorageAdapter implements StorageAdapter {
  constructor(private opts: S3Options) {}

  async deploy(siteDir: string, subdomain: string): Promise<void> {
    // Optional peer dependency: the non-literal specifier keeps tsc from
    // requiring @aws-sdk/client-s3 types when it isn't installed.
    const spec = "@aws-sdk/client-s3";
    let mod: any;
    try {
      mod = await import(spec);
    } catch {
      throw new Error(
        "S3 storage requires @aws-sdk/client-s3. Install it with: npm i @aws-sdk/client-s3",
      );
    }
    const missing = (
      ["bucket", "region", "accessKeyId", "secretAccessKey"] as const
    ).filter((k) => !this.opts[k]);
    if (missing.length) {
      throw new Error(
        `S3 storage is missing: ${missing.join(", ")}. ` +
          `Set BREWDOCS_S3_* env vars or the s3 block in brewdocs.yml.`,
      );
    }
    const { S3Client, PutObjectCommand } = mod;
    const client = new S3Client({
      region: this.opts.region,
      endpoint: this.opts.endpoint,
      credentials: {
        accessKeyId: this.opts.accessKeyId,
        secretAccessKey: this.opts.secretAccessKey,
      },
    });

    const files = listFiles(siteDir);
    for (const file of files) {
      const rel = path.relative(siteDir, file).split(path.sep).join("/");
      const body = fs.readFileSync(file);
      await client.send(
        new PutObjectCommand({
          Bucket: this.opts.bucket,
          Key: `${subdomain}/${rel}`,
          Body: body,
          ContentType: CONTENT_TYPES[path.extname(file)] ?? "application/octet-stream",
        }),
      );
    }
  }

  urlFor(subdomain: string): string {
    if (this.opts.publicDomain) {
      return `https://${subdomain}.${this.opts.publicDomain}`;
    }
    const host = this.opts.endpoint
      ? this.opts.endpoint.replace(/^https?:\/\//, "")
      : `${this.opts.bucket}.s3.${this.opts.region}.amazonaws.com`;
    return `https://${subdomain}.${host}`;
  }
}

export type StorageKind = "local" | "s3";

export function createStorage(
  kind: StorageKind,
  options: { local?: LocalStorageOptions; s3?: S3Options },
): StorageAdapter {
  if (kind === "s3") {
    if (!options.s3) throw new Error("S3 storage requires configuration");
    return new S3StorageAdapter(options.s3);
  }
  return new LocalStorageAdapter(options.local ?? { baseDir: "./hosting" });
}

function listFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...listFiles(full));
    else out.push(full);
  }
  return out;
}

function copyTree(src: string, dest: string): void {
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, entry.name);
    const d = path.join(dest, entry.name);
    if (entry.isDirectory()) {
      fs.mkdirSync(d, { recursive: true });
      copyTree(s, d);
    } else {
      fs.copyFileSync(s, d);
    }
  }
}
