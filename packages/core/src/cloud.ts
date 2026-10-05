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

/** One org member: a hashed key plus its label and join date. */
export interface OrgMember {
  /** SHA-256 of the issued API key (raw keys are never stored). */
  keyHash: string;
  label?: string;
  role: OrgRole;
  addedAt: string;
}

/** One org: its display name, member list and claimed site subdomains. */
export interface OrgRecord {
  name: string;
  createdAt: string;
  members: OrgMember[];
  sites: string[];
}

/** On-disk shape of `.cloud.json` — every org keyed by slug. */
export interface CloudStore {
  orgs: Record<string, OrgRecord>;
}

const CLOUD_FILE = ".cloud.json";

function fileFor(hostingDir: string): string {
  return path.join(hostingDir, CLOUD_FILE);
}

/**
 * Load the cloud control-plane store from `<hostingDir>/.cloud.json`.
 *
 * @param hostingDir - hosting root holding the `.cloud.json` org registry.
 * @returns the parsed store, or an empty store when the file is missing or malformed.
 */
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

/**
 * Hash a raw API key with SHA-256.
 *
 * @param key - raw API key to hash.
 * @returns the hex-encoded SHA-256 digest stored in the org registry.
 */
export function hashKey(key: string): string {
  return crypto.createHash("sha256").update(key).digest("hex");
}

/**
 * Accept either a raw `bd_live_…` key or an already-hexed hash.
 *
 * @param keyOrHash - raw `bd_live_…` key or a pre-computed SHA-256 hex hash.
 * @returns the SHA-256 hex hash (hashing raw keys, passing hashes through).
 */
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

/**
 * List every org in the control-plane store.
 *
 * @param hostingDir - hosting root holding the `.cloud.json` org registry.
 * @returns org records sorted by name.
 */
export function listOrgs(hostingDir: string): OrgRecord[] {
  return Object.values(loadCloud(hostingDir).orgs).sort((a, b) =>
    a.name.localeCompare(b.name),
  );
}

/**
 * Look up a single org by name.
 *
 * @param hostingDir - hosting root holding the `.cloud.json` org registry.
 * @param org - org name (slugged before lookup).
 * @returns the org record, or undefined when no such org exists.
 */
export function getOrg(hostingDir: string, org: string): OrgRecord | undefined {
  return loadCloud(hostingDir).orgs[slug(org)];
}

/**
 * Create an org; returns false when the name is taken.
 *
 * @param hostingDir - hosting root holding the `.cloud.json` org registry.
 * @param org - org name to create (slugged; empty slugs are rejected).
 * @returns the created org record, or null when the name is empty or already taken.
 */
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

/**
 * Delete an org from the control-plane store.
 *
 * @param hostingDir - hosting root holding the `.cloud.json` org registry.
 * @param org - org name to delete (slugged before lookup).
 * @returns true when an org was removed, false when it did not exist.
 */
export function deleteOrg(hostingDir: string, org: string): boolean {
  const name = slug(org);
  const store = loadCloud(hostingDir);
  if (!store.orgs[name]) return false;
  delete store.orgs[name];
  saveCloud(hostingDir, store);
  return true;
}

/**
 * Add a member key; returns false when the org is missing.
 *
 * @param hostingDir - hosting root holding the `.cloud.json` org registry.
 * @param org - org name to add the member to (slugged before lookup).
 * @param keyOrHash - raw `bd_live_…` key or pre-hashed key to register.
 * @param opts - optional member `label` and `role` (defaults to "member").
 * @returns true when the org exists and the member is now present, false when the org is unknown.
 */
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

/**
 * Remove a member key from an org.
 *
 * @param hostingDir - hosting root holding the `.cloud.json` org registry.
 * @param org - org name to remove the member from (slugged before lookup).
 * @param keyOrHash - raw `bd_live_…` key or pre-hashed key to revoke.
 * @returns true when a matching member was removed, false when the org or member was absent.
 */
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

/**
 * Does a presented key (raw `bd_live_…` or bearer string) belong to the org?
 *
 * @param hostingDir - hosting root holding the `.cloud.json` org registry.
 * @param org - org name to check membership against (slugged before lookup).
 * @param presented - key presented by the caller, or undefined when none was supplied.
 * @returns true when the presented key hashes to a registered member of the org.
 */
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

/**
 * Record that an org owns a deployed site (idempotent).
 *
 * @param hostingDir - hosting root holding the `.cloud.json` org registry.
 * @param org - org that owns the site (slugged before lookup).
 * @param subdomain - deployed site subdomain to claim for the org.
 * @returns nothing; writes the store only when the site was not already claimed.
 */
export function recordOrgSite(hostingDir: string, org: string, subdomain: string): void {
  const store = loadCloud(hostingDir);
  const record = store.orgs[slug(org)];
  if (!record) return;
  if (!record.sites.includes(subdomain)) {
    record.sites.push(subdomain);
    saveCloud(hostingDir, store);
  }
}

/**
 * All sites claimed by an org (empty when the org is unknown).
 *
 * @param hostingDir - hosting root holding the `.cloud.json` org registry.
 * @param org - org name to list sites for (slugged before lookup).
 * @returns the org's claimed subdomains, or an empty array when the org is unknown.
 */
export function listOrgSites(hostingDir: string, org: string): string[] {
  return loadCloud(hostingDir).orgs[slug(org)]?.sites ?? [];
}

/**
 * Which org (if any) owns a deployed subdomain?
 *
 * @param hostingDir - hosting root holding the `.cloud.json` org registry.
 * @param subdomain - deployed site subdomain to look up.
 * @returns the owning org name, or undefined when no org claims the subdomain.
 */
export function orgOfSite(hostingDir: string, subdomain: string): string | undefined {
  for (const [name, record] of Object.entries(loadCloud(hostingDir).orgs)) {
    if (record.sites.includes(subdomain)) return name;
  }
  return undefined;
}

/**
 * Sum per-site stats records into an org rollup.
 *
 * @param statsBySite - per-subdomain stats keyed by site name.
 * @param sites - subdomains to include in the rollup.
 * @returns the included site list with total views and builds.
 */
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
