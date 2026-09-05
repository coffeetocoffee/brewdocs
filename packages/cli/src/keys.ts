import * as fs from "node:fs";
import * as path from "node:path";
import * as crypto from "node:crypto";

export interface ApiKeyRecord {
  /** SHA-256 of the issued key (the raw key is only shown once at creation). */
  hash: string;
  label?: string;
  /** Capabilities this key grants. Empty/absent means all scopes. */
  scopes: string[];
  ownedSites: string[];
  createdAt: string;
}

export const ALL_SCOPES = ["build", "export", "markdown"];

function fileFor(hostingDir: string): string {
  return path.join(hostingDir, ".keys.json");
}

export function loadKeys(hostingDir: string): ApiKeyRecord[] {
  try {
    return JSON.parse(fs.readFileSync(fileFor(hostingDir), "utf8")) as ApiKeyRecord[];
  } catch {
    return [];
  }
}

function saveKeys(hostingDir: string, keys: ApiKeyRecord[]): void {
  fs.mkdirSync(hostingDir, { recursive: true });
  fs.writeFileSync(fileFor(hostingDir), JSON.stringify(keys, null, 2), "utf8");
}

function hashKey(key: string): string {
  return crypto.createHash("sha256").update(key).digest("hex");
}

/** Issue a new API key, persisting only its hash. Returns the raw key once. */
export function addKey(
  hostingDir: string,
  opts: { scopes?: string[]; label?: string } = {},
): { key: string; record: ApiKeyRecord } {
  const key = "bd_live_" + crypto.randomBytes(24).toString("hex");
  const scopes = opts.scopes && opts.scopes.length ? opts.scopes : [...ALL_SCOPES];
  const record: ApiKeyRecord = {
    hash: hashKey(key),
    label: opts.label,
    scopes,
    ownedSites: [],
    createdAt: new Date().toISOString(),
  };
  const keys = loadKeys(hostingDir);
  keys.push(record);
  saveKeys(hostingDir, keys);
  return { key, record };
}

/** Validate a presented key against the store; returns the record or null. */
export function validateKey(
  hostingDir: string,
  presented: string | undefined,
): ApiKeyRecord | null {
  if (!presented) return null;
  const h = hashKey(presented);
  return loadKeys(hostingDir).find((k) => k.hash === h) ?? null;
}

export function listKeys(hostingDir: string): ApiKeyRecord[] {
  return loadKeys(hostingDir);
}

/** Revoke by raw key or stored hash prefix. Returns true if something was removed. */
export function revokeKey(hostingDir: string, keyOrHash: string): boolean {
  const h = keyOrHash.startsWith("bd_live_") ? hashKey(keyOrHash) : keyOrHash;
  const keys = loadKeys(hostingDir);
  const next = keys.filter((k) => k.hash !== h);
  if (next.length === keys.length) return false;
  saveKeys(hostingDir, next);
  return true;
}

/** Record that a key owns a deployed site (used for future per-user management). */
export function claimSite(hostingDir: string, keyHash: string, subdomain: string): void {
  const keys = loadKeys(hostingDir);
  const rec = keys.find((k) => k.hash === keyHash);
  if (rec && !rec.ownedSites.includes(subdomain)) {
    rec.ownedSites.push(subdomain);
    saveKeys(hostingDir, keys);
  }
}
