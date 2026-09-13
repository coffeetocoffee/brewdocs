import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";

/**
 * v2.5 cloud control plane (local emulation, zero dependencies). Persists an
 * org registry next to the hosting dir (`.cloud.json`) that maps:
 *
 *   - org -> members (API-key hashes, admin/member roles)
 *   - org -> owned sites (subdomains)
 *
 * So a deployed private site with `--org acme` is readable by any `acme`
 * member key, and the server can roll up per-org analytics. Keys are always
 * stored/compared as SHA-256 hex (the same `bd_live_…` scheme as keys.ts).
 */

export type OrgRole = "admin" | "member";

export interface OrgMember {
  /** SHA-256 of the issued API key (raw keys are never stored). */
  keyHash: string;
  label?: string;
  role: OrgRole;
  addedAt: string;
}

export interface OrgRecord {
  name: string;
  createdAt: string;
  members: OrgMember[];
  sites: string[];
}

export interface CloudStore {
  orgs: Record<string, OrgRecord>;
}

const CLOUD_FILE = ".cloud.json";

function fileFor(hostingDir: string): string {
  return path.join(hostingDir, CLOUD_FILE);
}

export function loadCloud(hostingDir: string): CloudStore {
  try {
    const raw = JSON.parse(fs.readFileSync(fileFor(hostingDir), "utf8")) as CloudStore;
    if (raw && typeof raw === "object" && raw.orgs && typeof raw.orgs === "object") {
      return raw;
    }
  } catch {
    /* fresh store */
  }
  return { orgs: {} };
}

function saveCloud(hostingDir: string, store: CloudStore): void {
  fs.mkdirSync(hostingDir, { recursive: true });
  fs.writeFileSync(fileFor(hostingDir), JSON.stringify(store, null, 2), "utf8");
}

export function hashKey(key: string): string {
  return crypto.createHash("sha256").update(key).digest("hex");
}

/** Accept either a raw `bd_live_…` key or an already-hexed hash. */
export function normalizeKeyHash(keyOrHash: string): string {
  if (keyOrHash.startsWith("bd_live_")) return hashKey(keyOrHash);
  return keyOrHash;
}

function slug(name: string): string {
  return name
    .toLowerCase()
    .replace(/^@/, "")
    .replace(/\//g, "-")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

export function listOrgs(hostingDir: string): OrgRecord[] {
  return Object.values(loadCloud(hostingDir).orgs).sort((a, b) =>
    a.name.localeCompare(b.name),
  );
}

export function getOrg(hostingDir: string, org: string): OrgRecord | undefined {
  return loadCloud(hostingDir).orgs[slug(org)];
}

/** Create an org; returns false when the name is taken. */
export function createOrg(hostingDir: string, org: string): OrgRecord | null {
  const name = slug(org);
  if (!name) return null;
  const store = loadCloud(hostingDir);
  if (store.orgs[name]) return null;
  const record: OrgRecord = {
    name,
    createdAt: new Date().toISOString(),
    members: [],
    sites: [],
  };
  store.orgs[name] = record;
  saveCloud(hostingDir, store);
  return record;
}

export function deleteOrg(hostingDir: string, org: string): boolean {
  const name = slug(org);
  const store = loadCloud(hostingDir);
  if (!store.orgs[name]) return false;
  delete store.orgs[name];
  saveCloud(hostingDir, store);
  return true;
}

/** Add a member key; returns false when the org is missing. */
export function addOrgMember(
  hostingDir: string,
  org: string,
  keyOrHash: string,
  opts: { label?: string; role?: OrgRole } = {},
): boolean {
  const store = loadCloud(hostingDir);
  const record = store.orgs[slug(org)];
  if (!record) return false;
  const keyHash = normalizeKeyHash(keyOrHash);
  if (!record.members.some((m) => m.keyHash === keyHash)) {
    record.members.push({
      keyHash,
      label: opts.label,
      role: opts.role ?? "member",
      addedAt: new Date().toISOString(),
    });
    saveCloud(hostingDir, store);
  }
  return true;
}

export function removeOrgMember(
  hostingDir: string,
  org: string,
  keyOrHash: string,
): boolean {
  const store = loadCloud(hostingDir);
  const record = store.orgs[slug(org)];
  if (!record) return false;
  const keyHash = normalizeKeyHash(keyOrHash);
  const before = record.members.length;
  record.members = record.members.filter((m) => m.keyHash !== keyHash);
  if (record.members.length === before) return false;
  saveCloud(hostingDir, store);
  return true;
}

/** Does a presented key (raw `bd_live_…` or bearer string) belong to the org? */
export function canAccessOrg(
  hostingDir: string,
  org: string,
  presented: string | undefined,
): boolean {
  if (!presented) return false;
  const record = loadCloud(hostingDir).orgs[slug(org)];
  if (!record) return false;
  const keyHash = normalizeKeyHash(presented);
  return record.members.some((m) => m.keyHash === keyHash);
}

/** Record that an org owns a deployed site (idempotent). */
export function recordOrgSite(hostingDir: string, org: string, subdomain: string): void {
  const store = loadCloud(hostingDir);
  const record = store.orgs[slug(org)];
  if (!record) return;
  if (!record.sites.includes(subdomain)) {
    record.sites.push(subdomain);
    saveCloud(hostingDir, store);
  }
}

/** All sites claimed by an org (empty when the org is unknown). */
export function listOrgSites(hostingDir: string, org: string): string[] {
  return loadCloud(hostingDir).orgs[slug(org)]?.sites ?? [];
}

/** Which org (if any) owns a deployed subdomain? */
export function orgOfSite(hostingDir: string, subdomain: string): string | undefined {
  for (const [name, record] of Object.entries(loadCloud(hostingDir).orgs)) {
    if (record.sites.includes(subdomain)) return name;
  }
  return undefined;
}

/** Sum per-site stats records into an org rollup. */
export function aggregateOrgStats(
  statsBySite: Record<string, { views: number; builds: number }>,
  sites: string[],
): { sites: string[]; views: number; builds: number } {
  let views = 0;
  let builds = 0;
  for (const s of sites) {
    views += statsBySite[s]?.views ?? 0;
    builds += statsBySite[s]?.builds ?? 0;
  }
  return { sites, views, builds };
}
