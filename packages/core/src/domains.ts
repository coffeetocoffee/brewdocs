import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";

/**
 * v2.5 custom domains + TLS (local emulation, zero dependencies). A domain
 * registry (`.domains.json` beside the hosting dir) maps a custom hostname to
 * a deployed subdomain. Verification proves control of the domain by serving
 * a token at `/.well-known/brewdocs.txt`; TLS is serve-side (the operator
 * brings a certificate, e.g. from a CA, and points `serve --tls-cert/--tls-key`
 * at it — real issuance is a cloud concern).
 */

export interface DomainRecord {
  /** Lowercased custom hostname, e.g. `docs.acme.com`. */
  domain: string;
  /** Deployed subdomain served on this domain. */
  subdomain: string;
  /** Verification token to publish at `/.well-known/brewdocs.txt`. */
  token: string;
  verified: boolean;
  verifiedAt?: string;
  createdAt: string;
}

export interface DomainsStore {
  domains: Record<string, DomainRecord>;
}

const DOMAINS_FILE = ".domains.json";
const WELL_KNOWN_PATH = "/.well-known/brewdocs.txt";

function fileFor(hostingDir: string): string {
  return path.join(hostingDir, DOMAINS_FILE);
}

export function loadDomains(hostingDir: string): DomainsStore {
  try {
    const raw = JSON.parse(fs.readFileSync(fileFor(hostingDir), "utf8")) as DomainsStore;
    if (raw && typeof raw === "object" && raw.domains && typeof raw.domains === "object") {
      return raw;
    }
  } catch {
    /* fresh store */
  }
  return { domains: {} };
}

function saveDomains(hostingDir: string, store: DomainsStore): void {
  fs.mkdirSync(hostingDir, { recursive: true });
  fs.writeFileSync(fileFor(hostingDir), JSON.stringify(store, null, 2), "utf8");
}

function normalize(domain: string): string {
  return domain.trim().toLowerCase().replace(/\/+$/, "");
}

/** Claim a domain for a site; returns a record with the token to publish. */
export function addDomain(
  hostingDir: string,
  domain: string,
  subdomain: string,
): DomainRecord | null {
  const d = normalize(domain);
  const sub = subdomain.trim();
  if (!d || !sub || d.includes(" ") || d.includes("/")) return null;
  const store = loadDomains(hostingDir);
  const record: DomainRecord = store.domains[d] ?? {
    domain: d,
    subdomain: sub,
    token: "bd-verify-" + crypto.randomBytes(16).toString("hex"),
    verified: false,
    createdAt: new Date().toISOString(),
  };
  record.subdomain = sub;
  store.domains[d] = record;
  saveDomains(hostingDir, store);
  return record;
}

export function removeDomain(hostingDir: string, domain: string): boolean {
  const store = loadDomains(hostingDir);
  const d = normalize(domain);
  if (!store.domains[d]) return false;
  delete store.domains[d];
  saveDomains(hostingDir, store);
  return true;
}

export function listDomains(hostingDir: string): DomainRecord[] {
  return Object.values(loadDomains(hostingDir).domains).sort((a, b) =>
    a.domain.localeCompare(b.domain),
  );
}

export function getDomain(hostingDir: string, domain: string): DomainRecord | undefined {
  return loadDomains(hostingDir).domains[normalize(domain)];
}

/** Expected well-known verification URL contents for a domain record. */
export function wellKnownToken(record: DomainRecord): string {
  return record.token;
}

export function wellKnownPath(): string {
  return WELL_KNOWN_PATH;
}

/**
 * Verify control of a domain. The default resolver fetches the token over
 * HTTPS from `https://<domain>/.well-known/brewdocs.txt` (global fetch);
 * pass a custom resolver in tests or offline setups. A matching body marks
 * the domain verified (true); anything else leaves it pending (false).
 */
export async function verifyDomain(
  hostingDir: string,
  domain: string,
  resolve?: (domain: string) => Promise<string | undefined>,
): Promise<boolean> {
  const record = getDomain(hostingDir, domain);
  if (!record) return false;
  const check = resolve ?? defaultResolver;
  let body: string | undefined;
  try {
    body = await check(record.domain);
  } catch {
    return false;
  }
  const ok = typeof body === "string" && body.trim() === record.token;
  if (ok) {
    const store = loadDomains(hostingDir);
    const rec = store.domains[record.domain];
    if (rec) {
      rec.verified = true;
      rec.verifiedAt = new Date().toISOString();
      saveDomains(hostingDir, store);
    }
  }
  return ok;
}

async function defaultResolver(domain: string): Promise<string | undefined> {
  const res = await fetch(`https://${domain}${WELL_KNOWN_PATH}`, { redirect: "follow" });
  if (!res.ok) return undefined;
  return (await res.text()).trim();
}

/** Read a PEM file for the TLS server; returns undefined (caller warns) when missing. */
export function readTlsFile(file: string): string | undefined {
  try {
    return fs.readFileSync(file, "utf8");
  } catch {
    return undefined;
  }
}
