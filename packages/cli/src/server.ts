import * as http from "node:http";
import * as https from "node:https";
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import {
  combineSubdomain,
  deploySite,
  deriveSubdomain,
  draftExpired,
  escapeHtml,
  exportSite,
  buildMarkdown,
  handleMcpRequest,
  resolveInput,
  safeEqual,
  type McpToolCall,
  type RenderOptions,
  type Source,
  type StorageAdapter,
  type Visibility,
} from "@brewdocs/core";
import { readFileSync } from "node:fs";
import { ALL_SCOPES, loadKeys, validateKey } from "./keys.js";
import {
  aggregateOrgStats,
  canAccessOrg,
  listOrgSites,
  loadDomains,
  loadFederation,
  loadRegistry,
  searchFederation,
} from "@brewdocs/core";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".svg": "image/svg+xml",
  ".txt": "text/plain; charset=utf-8",
};

interface SiteManifest {
  subdomain: string;
  org?: string;
  visibility?: Visibility;
  tokenHash?: string;
  /** v1.2 private drafts: draft flag + expiry (ISO 8601). */
  draft?: boolean;
  draftExpires?: string;
  url?: string;
  title?: string;
  generatedAt?: string;
  pages?: number;
}

interface SiteStats {
  views: number;
  builds: number;
  /** v2.5: per-path pageview counts, so owners see which pages get read. */
  paths?: Record<string, number>;
  lastViewed?: string;
  lastBuild?: string;
  /** v4.5: total MCP tool calls served for this site. */
  toolCalls?: number;
  /** v4.5: one row per distinct (tool, query) — the closed-loop signal. */
  queries?: Record<string, QueryStat>;
}

/**
 * v4.5: what agents asked a site's docmodel for, and whether they found it.
 * A miss (lastHits 0) is the actionable half: the symbols people want that the
 * docs do not name. Aggregated per (tool, query) so repeated misses rank up.
 */
interface QueryStat {
  tool: string;
  query: string;
  calls: number;
  misses: number;
  lastHits: number;
  lastAt: string;
}

/** One unanswered-query row, as returned by `gapReport`. */
export interface GapEntry {
  site: string;
  tool: string;
  query: string;
  calls: number;
  misses: number;
}

/** Per-site pageview/build/tool-call counters, persisted next to the hosting dir. */
class StatsStore {
  private data = new Map<string, SiteStats>();
  constructor(private file: string) {
    this.load();
  }
  private load(): void {
    try {
      const raw = JSON.parse(readFileSync(this.file, "utf8")) as Record<
        string,
        SiteStats
      >;
      for (const [k, v] of Object.entries(raw)) this.data.set(k, v);
    } catch {
      /* fresh store */
    }
  }
  private save(): void {
    try {
      fs.writeFileSync(this.file, JSON.stringify(Object.fromEntries(this.data)), "utf8");
    } catch {
      /* best-effort */
    }
  }
  recordBuild(sub: string): void {
    const s = this.data.get(sub) ?? { views: 0, builds: 0 };
    s.builds++;
    s.lastBuild = new Date().toISOString();
    this.data.set(sub, s);
    this.save();
  }
  recordView(sub: string, page?: string): void {
    const s = this.data.get(sub) ?? { views: 0, builds: 0 };
    s.views++;
    s.lastViewed = new Date().toISOString();
    if (page) {
      s.paths ??= {};
      s.paths[page] = (s.paths[page] ?? 0) + 1;
    }
    this.data.set(sub, s);
    this.save();
  }
  /**
   * v4.5: record one MCP `tools/call`. `call.hits === 0` is a miss — the agent
   * asked for something the docs could not name. This is the only write path
   * that turns a site's consumption back into a signal its owner can act on.
   */
  recordToolCall(sub: string, call: McpToolCall): void {
    const s = this.data.get(sub) ?? { views: 0, builds: 0 };
    s.toolCalls = (s.toolCalls ?? 0) + 1;
    s.queries ??= {};
    const key = `${call.tool}\u0000${call.query}`;
    const row = s.queries[key] ?? {
      tool: call.tool,
      query: call.query,
      calls: 0,
      misses: 0,
      lastHits: 0,
      lastAt: "",
    };
    row.calls++;
    if (call.hits === 0) row.misses++;
    row.lastHits = call.hits;
    row.lastAt = new Date().toISOString();
    s.queries[key] = row;
    this.data.set(sub, s);
    this.save();
  }
  /**
   * Queries that returned nothing, ranked by miss count. With no `site`, rolls
   * up every site. This is what `brewdocs gap` prints: the documentation gap
   * the product can see because it now watches what it is asked for.
   */
  gapReport(site?: string, limit = 20): GapEntry[] {
    const out: GapEntry[] = [];
    for (const [sub, s] of this.data) {
      if (site && sub !== site) continue;
      for (const row of Object.values(s.queries ?? {})) {
        if (row.misses > 0) {
          out.push({
            site: sub,
            tool: row.tool,
            query: row.query,
            calls: row.calls,
            misses: row.misses,
          });
        }
      }
    }
    return out
      .sort((a, b) => b.misses - a.misses || a.query.localeCompare(b.query))
      .slice(0, limit);
  }
  /** Top-viewed paths for a site (dashboard + org rollup). */
  topPaths(sub: string, limit = 8): Array<{ path: string; views: number }> {
    const paths = this.data.get(sub)?.paths ?? {};
    return Object.entries(paths)
      .sort((a, b) => b[1] - a[1])
      .slice(0, limit)
      .map(([p, views]) => ({ path: p, views }));
  }
  get(sub?: string): SiteStats | Record<string, SiteStats> {
    if (sub) return this.data.get(sub) ?? { views: 0, builds: 0 };
    return Object.fromEntries(this.data);
  }
}

/**
 * v4.5: read the query-gap report from a hosting dir's analytics store. Shared
 * by the CLI `gap` command and `GET /api/gap`, so both answer from one place.
 */
export function readGapReport(
  hostingDir: string,
  site?: string,
  limit = 20,
): GapEntry[] {
  return new StatsStore(path.join(hostingDir, ".analytics.json")).gapReport(site, limit);
}

export interface ServeOptions {
  hostingDir: string;
  port: number;
}

export interface ProtectionOptions {
  rateLimit?: number;
  rateWindowMs?: number;
  maxConcurrentBuilds?: number;
  maxQueue?: number;
  /**
   * v3.9 finding #10: trust the left-most `X-Forwarded-For` value as the client
   * identity. Off by default — the header is caller-controlled, so honouring it
   * unconditionally lets a client defeat the rate limiter by rotating the value.
   * Enable only behind a known proxy (env `BREWDOCS_TRUST_PROXY`).
   */
  trustProxy?: boolean;
  /**
   * v3.5 security: the only directory tree the build/export/markdown API is
   * allowed to read from. A caller-supplied `source` that is a local path is
   * confined here, so the hosted API can't be turned into a file-disclosure
   * primitive for any readable directory on the machine. Package names and
   * GitHub URLs are unaffected (they are fetched, not read locally).
   *
   * Default: `BREWDOCS_SOURCE_ROOT`, else the server's own working directory.
   */
  sourceRoot?: string;
}

/** Raised when a build source is a local path outside the allowed root. */
export class SourceNotAllowedError extends Error {
  constructor(public readonly reason: string) {
    super(reason);
    this.name = "SourceNotAllowedError";
  }
}

/** Real (symlink-resolved) path, falling back to the lexical path. */
function realpathOr(p: string): string {
  try {
    return fs.realpathSync.native(p);
  } catch {
    return p;
  }
}

const NPM_NAME_RE = /^(@[a-z0-9-~][a-z0-9-._~]*\/)?[a-z0-9-~][a-z0-9-._~]*$/i;

/**
 * Is this input a local filesystem path (vs an npm name / GitHub URL)?
 * Mirrors resolveInput's branch order: an existing path wins, then an npm
 * name/URL, then a GitHub URL. Everything else (absolute/relative paths,
 * `..`, `~`) is treated as a local path and must pass containment.
 */
function looksLikeLocalPath(input: string): boolean {
  const raw = input.trim();
  if (!raw) return false;
  if (fs.existsSync(raw)) return true;
  if (NPM_NAME_RE.test(raw)) return false;
  if (/^https?:\/\/(www\.)?npmjs\.com\/package\//i.test(raw)) return false;
  if (/github\.com[/:]/i.test(raw)) return false;
  return true;
}

/**
 * Resolve a caller-supplied source for the HTTP API, refusing local paths
 * outside `sourceRoot`. Throws SourceNotAllowedError so the handler can
 * answer 403 rather than silently rendering an arbitrary directory.
 */
function resolveServerSource(input: string, sourceRoot: string): string {
  if (!looksLikeLocalPath(input)) return input;
  const root = realpathOr(path.resolve(sourceRoot));
  const real = realpathOr(path.resolve(input));
  const inRoot = real === root || real.startsWith(root + path.sep);
  if (!inRoot) {
    throw new SourceNotAllowedError(
      `local source outside the allowed root: ${input}`,
    );
  }
  return input;
}

export class BuildQueueFullError extends Error {
  constructor() {
    super("build queue is full");
    this.name = "BuildQueueFullError";
  }
}

class RateLimiter {
  private hits = new Map<string, { count: number; resetAt: number }>();
  constructor(private limit: number, private windowMs: number) {
    const timer = setInterval(() => this.prune(), this.windowMs);
    timer.unref?.();
  }
  private prune(): void {
    const now = Date.now();
    for (const [key, rec] of this.hits) {
      if (now >= rec.resetAt) this.hits.delete(key);
    }
  }
  check(key: string): { ok: boolean; retryAfterSec: number } {
    const now = Date.now();
    const rec = this.hits.get(key);
    if (!rec || now >= rec.resetAt) {
      this.hits.set(key, { count: 1, resetAt: now + this.windowMs });
      return { ok: true, retryAfterSec: 0 };
    }
    if (rec.count >= this.limit) {
      return { ok: false, retryAfterSec: Math.ceil((rec.resetAt - now) / 1000) };
    }
    rec.count++;
    return { ok: true, retryAfterSec: 0 };
  }
}

class BuildQueue {
  private active = 0;
  private pending: Array<{
    job: () => Promise<unknown>;
    resolve: (v: unknown) => void;
    reject: (e: unknown) => void;
  }> = [];
  constructor(private maxConcurrent: number, private maxQueue: number) {}
  enqueue<T>(job: () => Promise<T>): Promise<T> {
    if (this.active >= this.maxConcurrent) {
      if (this.pending.length >= this.maxQueue) {
        return Promise.reject(new BuildQueueFullError());
      }
      return new Promise<T>((resolve, reject) => {
        this.pending.push({
          job: job as () => Promise<unknown>,
          resolve: resolve as (v: unknown) => void,
          reject,
        });
      });
    }
    return this.start(job);
  }
  private start<T>(job: () => Promise<T>): Promise<T> {
    this.active++;
    return job().finally(() => {
      this.active--;
      const next = this.pending.shift();
      if (next) {
        Promise.resolve(this.start(next.job as () => Promise<unknown>))
          .then(next.resolve, next.reject);
      }
    });
  }
}

function clientKey(req: http.IncomingMessage, trustProxy = false): string {
  if (trustProxy) {
    const fwd = req.headers["x-forwarded-for"];
    if (typeof fwd === "string" && fwd.length) return fwd.split(",")[0].trim();
  }
  return req.socket.remoteAddress ?? "unknown";
}

function numOption(
  value: number | undefined,
  env: string | undefined,
  fallback: number,
): number {
  const v = value ?? (env !== undefined ? Number(env) : undefined);
  if (v === undefined || Number.isNaN(v)) return fallback;
  return v;
}

function packageName(root: string): string | undefined {
  try {
    const pkg = JSON.parse(
      readFileSync(path.join(root, "package.json"), "utf8"),
    );
    if (typeof pkg.name === "string") return pkg.name;
  } catch {
    /* ignore */
  }
  return undefined;
}

function subdomainFor(resolved: Source, requested?: string, org?: string): string {
  const isGithub = /github\.com/i.test(resolved.name ?? "");
  const base = requested ?? (isGithub ? resolved.name : packageName(resolved.root) ?? resolved.name);
  return combineSubdomain(org, deriveSubdomain({ root: resolved.root, name: base }));
}

function readManifest(
  hostingDir: string,
  subdomain: string,
): SiteManifest | undefined {
  try {
    return JSON.parse(
      readFileSync(path.join(hostingDir, subdomain, ".brewdocs.json"), "utf8"),
    ) as SiteManifest;
  } catch {
    return undefined;
  }
}

/**
 * Does the request prove access to a private site (or hold the admin token)?
 * v2.5: members of the site's org (any valid member key as the Bearer token)
 * can read that org's private docs — the org is the sharing group.
 */
function requireSiteAccess(
  req: http.IncomingMessage,
  manifest: SiteManifest | undefined,
  adminToken: string | undefined,
  hostingDir: string,
): boolean {
  const tokenHash = manifest?.tokenHash;
  if (!tokenHash) return true;
  if (adminToken && safeEqual(req.headers["authorization"] ?? "", `Bearer ${adminToken}`)) {
    return true;
  }
  const provided =
    req.headers["authorization"]?.replace(/^Bearer\s+/i, "") ??
    new URL(req.url ?? "/", "http://localhost").searchParams.get("token") ??
    "";
  if (!provided) return false;
  const hash = crypto.createHash("sha256").update(provided).digest("hex");
  if (safeEqual(hash, tokenHash)) return true;
  const org = manifest?.org;
  return Boolean(org) && canAccessOrg(hostingDir, org!, provided);
}

/**
 * Map a request to a hosted site file, supporting:
 *   - path routing:  /s/<subdomain>/<rest>
 *   - host routing:  <subdomain>.brewdocs.dev/<rest>
 *   - v2.5 custom domains: a verified entry in `.domains.json` serves its
 *     site at the domain root (the Host header names the site).
 * Returns null when no site is targeted.
 */
export function resolveSite(
  pathname: string,
  host: string | undefined,
  hostingDir: string,
): { subdomain: string; filePath: string } | null {
  let sub: string | undefined;
  let rest = "/index.html";

  const m = /^\/s\/([^/]+)(\/.*)?$/.exec(pathname);
  if (m) {
    sub = m[1];
    rest = m[2] && m[2] !== "/" ? m[2] : "/index.html";
  } else if (host) {
    const h = host.split(":")[0];
    const subMatch = /^(.+)\.brewdocs\.dev$/.exec(h);
    if (subMatch) {
      sub = subMatch[1];
    } else {
      // Custom domain fallback (live read: domains can be added while the
      // server runs). Unverified mappings are ignored.
      try {
        const record = loadDomains(hostingDir).domains[h.toLowerCase()];
        if (record?.verified) {
          sub = record.subdomain;
          rest = pathname && !pathname.endsWith("/") ? pathname : "/index.html";
        }
      } catch {
        /* offline/errored registry: fall through to null */
      }
    }
  }

  if (!sub) return null;
  // v3.5 security: reject anything that isn't a plain site slug. `..`, `.`,
  // dots-only, and separator-bearing values must never reach path resolution
  // (the Host header is caller-controlled and `...brewdocs.dev` slugifies to
  // `..`, which peeks above the hosting dir).
  if (!SAFE_SUBDOMAIN.test(sub)) return null;
  const base = path.resolve(hostingDir, sub);
  // Boundary-aware containment. A bare startsWith() accepts a sibling whose
  // name shares the prefix (`/s/acme/../acme-secret`), so resolve first and
  // require base itself or base + separator.
  const filePath = path.resolve(base, "." + rest);
  const inBase = filePath === base || filePath.startsWith(base + path.sep);
  const inHosting = filePath.startsWith(path.resolve(hostingDir) + path.sep);
  if (!inBase || !inHosting) return null;
  if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) return null;
  return { subdomain: sub, filePath };
}

/**
 * A site slug must be a plain DNS-ish label: no dots-only, no separators, no
 * percent-encoding escape hatches. Shared invariant for both route forms.
 */
const SAFE_SUBDOMAIN = /^(?!\.+$)[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:--[a-z0-9-]+)*$/i;

/** Is this Host a verified custom domain (serves its site, not the drop-in)? */
function isCustomDomainHost(host: string | undefined, hostingDir: string): boolean {
  if (!host) return false;
  try {
    return Boolean(loadDomains(hostingDir).domains[host.split(":")[0].toLowerCase()]?.verified);
  } catch {
    return false;
  }
}

function listSites(
  hostingDir: string,
): Array<{ subdomain: string; url: string; title?: string; org?: string; visibility?: Visibility }> {
  try {
    return fs
      .readdirSync(hostingDir)
      .filter((d) => fs.existsSync(path.join(hostingDir, d, "index.html")))
      .map((d) => {
        const manifest = readManifest(hostingDir, d);
        return {
          subdomain: d,
          url: `https://${d}.brewdocs.dev`,
          title: manifest?.title,
          org: manifest?.org,
          visibility: manifest?.visibility ?? "public",
        };
      });
  } catch {
    return [];
  }
}

function fallbackLanding(sites: Array<{ subdomain: string; url: string }>): string {
  const items = sites.length
    ? sites
        .map(
          (s) =>
            `<li><a href="/s/${s.subdomain}/">${s.subdomain}</a> → <code>https://${s.subdomain}.brewdocs.dev</code></li>`,
        )
        .join("\n")
    : `<li><em>No sites deployed yet. Run: brewdocs deploy ./examples/lib</em></li>`;
  return `<!doctype html><html><head><meta charset="utf-8"><title>BrewDocs Hosting</title>
<style>body{font-family:system-ui,sans-serif;max-width:720px;margin:3rem auto;padding:0 1rem;color:#2b2118}code{background:#f0e7d8;padding:.1rem .35rem;border-radius:4px}a{color:#b5651d}</style></head>
<body><h1>☕ BrewDocs Hosting</h1>
<p>Locally emulated <code>*.brewdocs.dev</code> hosting. Each deployed site is served at <code>/s/&lt;subdomain&gt;/</code> or its virtual host.</p>
<h2>Deployed sites</h2><ul>${items}</ul></body></html>`;
}

const DROPIN = path.join(__dirname, "web", "dropin.html");

/**
 * Shared request listener for the plain and TLS servers. Extracted so
 * `createSecureServer` reuses the whole pipeline (routing, auth, analytics)
 * over HTTPS with the operator's certificate.
 */
function buildRequestHandler(
  hostingDir: string,
  storage?: StorageAdapter,
  token?: string,
  protection?: ProtectionOptions,
): (req: http.IncomingMessage, res: http.ServerResponse) => Promise<void> {
  fs.mkdirSync(hostingDir, { recursive: true });

  const limiter = new RateLimiter(
    numOption(protection?.rateLimit, process.env.BREWDOCS_RATE_LIMIT, 10),
    numOption(protection?.rateWindowMs, process.env.BREWDOCS_RATE_WINDOW_MS, 60000),
  );
  const queue = new BuildQueue(
    numOption(protection?.maxConcurrentBuilds, process.env.BREWDOCS_MAX_BUILDS, 2),
    numOption(protection?.maxQueue, process.env.BREWDOCS_MAX_QUEUE, 8),
  );
  const stats = new StatsStore(path.join(hostingDir, ".analytics.json"));
  // Require credentials only once *some* auth is configured (admin token or keys).
  const needsAuth = Boolean(token) || loadKeys(hostingDir).length > 0;

  // v3.5 security: where the build API may read local sources from. Defaults to
  // the server's own working directory so a bare `brewdocs serve` can still
  // start from the repo you launched it in, but cannot be pointed at /etc or
  // another user's home by a remote caller.
  const sourceRoot = path.resolve(
    protection?.sourceRoot ?? process.env.BREWDOCS_SOURCE_ROOT ?? process.cwd(),
  );

  // v3.9 finding #10: X-Forwarded-For is only meaningful behind a proxy that
  // overwrites it. Trust it only when the operator opts in.
  const trustProxy =
    protection?.trustProxy ?? process.env.BREWDOCS_TRUST_PROXY === "1";

  /** Guard a caller-supplied source; 403s and returns undefined when refused. */
  const guardSource = (
    source: string,
    res: http.ServerResponse,
  ): string | undefined => {
    try {
      return resolveServerSource(source, sourceRoot);
    } catch (e) {
      if (e instanceof SourceNotAllowedError) {
        res
          .writeHead(403, { "content-type": TYPES[".json"] })
          .end(JSON.stringify({ error: "source not allowed", detail: e.reason }));
        return undefined;
      }
      throw e;
    }
  };

  // Write endpoints: admin token (all scopes) OR a valid per-user API key whose
  // scopes include the operation. Unlike requireAuth, an absent admin token does
  // NOT open the door when keys are configured. An empty scope list means all
  // scopes (keys.ts), matching `brewdocs keys add` with no --scope.
  const authorize = (
    req: http.IncomingMessage,
    scope: string,
  ): "ok" | "unauthorized" | "forbidden" => {
    if (!needsAuth) return "ok";
    const header = req.headers["authorization"] ?? "";
    if (token && safeEqual(header, `Bearer ${token}`)) return "ok";
    const presented = header.replace(/^Bearer\s+/i, "");
    const record = validateKey(hostingDir, presented);
    if (!record) return "unauthorized";
    const scopes = record.scopes?.length ? record.scopes : ALL_SCOPES;
    return scopes.includes(scope) ? "ok" : "forbidden";
  };

  const deny = (
    res: http.ServerResponse,
    auth: "unauthorized" | "forbidden",
  ): void => {
    res
      .writeHead(auth === "forbidden" ? 403 : 401, {
        "content-type": TYPES[".json"],
      })
      .end(
        JSON.stringify({
          error: auth === "forbidden" ? "forbidden" : "unauthorized",
        }),
      );
  };

  /**
   * v3.9 finding #11: read endpoints expose deployment, registry and federation
   * metadata. needsAuth is driven by the token OR configured keys, so when any
   * auth is configured these must not answer anonymously. With no auth at all
   * they stay open for local use (the drop-in UI reads them).
   */
  const authorizeRead = (req: http.IncomingMessage): boolean => {
    if (!needsAuth) return true;
    const header = req.headers["authorization"] ?? "";
    if (token && safeEqual(header, `Bearer ${token}`)) return true;
    return validateKey(hostingDir, header.replace(/^Bearer\s+/i, "")) !== null;
  };

  /**
   * v3.9 finding #16: a browser page on any origin can POST to an open instance
   * on the user's LAN with a simple request (no preflight), so trust the
   * browser's own same-origin signal when it sends one. Origin must match the
   * Host we were reached on; Sec-Fetch-Site must be same-origin or none.
   * Non-browser clients (curl, the test suite) send neither and are unaffected.
   */
  const isCrossSite = (req: http.IncomingMessage): boolean => {
    const site = req.headers["sec-fetch-site"];
    if (typeof site === "string" && site !== "same-origin" && site !== "none") {
      return true;
    }
    const origin = req.headers["origin"];
    if (typeof origin === "string") {
      try {
        return new URL(origin).host !== req.headers.host;
      } catch {
        return true; // "null" or malformed origin is not same-origin
      }
    }
    return false;
  };

  /**
   * The routing body. Wrapped below in a single guard (finding #21): this is
   * an async request listener, so any throw inside it rejects a promise with
   * no attached handler and Node exits the process — one malformed request
   * from an unauthenticated caller used to be able to kill the server.
   */
  const handle = async (req: http.IncomingMessage, res: http.ServerResponse): Promise<void> => {
    // A request line is caller-controlled and `new URL` throws on some of it
    // (`//[` is not a URL). 400 here rather than a 500 from the outer guard:
    // this one is the caller's fault and we know exactly what it is.
    let url: URL;
    try {
      url = new URL(req.url ?? "/", "http://localhost");
    } catch {
      res
        .writeHead(400, { "content-type": TYPES[".json"] })
        .end(JSON.stringify({ error: "bad request" }));
      return;
    }
    const host = req.headers.host;

    if (req.method === "POST" && isCrossSite(req)) {
      res
        .writeHead(403, { "content-type": TYPES[".json"] })
        .end(JSON.stringify({ error: "cross-site request refused" }));
      return;
    }

    if (url.pathname === "/api/build" && req.method === "POST") {
      const auth = authorize(req, "build");
      if (auth !== "ok") {
        deny(res, auth);
        return;
      }
      const limited = limiter.check(clientKey(req, trustProxy));
      if (!limited.ok) {
        res
          .writeHead(429, { "retry-after": String(limited.retryAfterSec) })
          .end(
            JSON.stringify({
              error: "rate limited",
              retryAfter: limited.retryAfterSec,
            }),
          );
        return;
      }

      let body = "";
      for await (const chunk of req) body += chunk;
      let data: {
        source?: string;
        name?: string;
        theme?: string;
        dark?: boolean;
        org?: string;
        visibility?: Visibility;
        token?: string;
      };
      try {
        data = JSON.parse(body || "{}") as typeof data;
      } catch {
        res.writeHead(400).end(JSON.stringify({ error: "invalid json" }));
        return;
      }
      if (!data.source) {
        res.writeHead(400).end(JSON.stringify({ error: "missing source" }));
        return;
      }
      const guardedSource = guardSource(data.source, res);
      if (guardedSource === undefined) return;
      data.source = guardedSource;

      try {
        const result = await queue.enqueue(() =>
          runBuild(data, hostingDir, storage),
        );
        stats.recordBuild(result.subdomain);
        res
          .writeHead(200, { "content-type": TYPES[".json"] })
          .end(JSON.stringify(result));
      } catch (e) {
        if (e instanceof BuildQueueFullError) {
          res
            .writeHead(503, { "retry-after": "5" })
            .end(JSON.stringify({ error: "server busy, try again shortly" }));
          return;
        }
        res
          .writeHead(500)
          .end(
            JSON.stringify({
              error: String(e instanceof Error ? e.message : e),
            }),
          );
      }
      return;
    }

    if (url.pathname === "/api/export" && req.method === "POST") {
      const auth = authorize(req, "export");
      if (auth !== "ok") {
        deny(res, auth);
        return;
      }
      const limited = limiter.check(clientKey(req, trustProxy));
      if (!limited.ok) {
        res
          .writeHead(429, { "retry-after": String(limited.retryAfterSec) })
          .end(
            JSON.stringify({
              error: "rate limited",
              retryAfter: limited.retryAfterSec,
            }),
          );
        return;
      }

      let body = "";
      for await (const chunk of req) body += chunk;
      let data: {
        source?: string;
        theme?: string;
        dark?: boolean;
        name?: string;
      };
      try {
        data = JSON.parse(body || "{}") as typeof data;
      } catch {
        res.writeHead(400).end(JSON.stringify({ error: "invalid json" }));
        return;
      }
      if (!data.source) {
        res.writeHead(400).end(JSON.stringify({ error: "missing source" }));
        return;
      }
      const guardedSource = guardSource(data.source, res);
      if (guardedSource === undefined) return;
      data.source = guardedSource;

      try {
        const out = await queue.enqueue(() => runExport(data));
        res.writeHead(200, {
          "content-type": TYPES[".html"],
          "content-disposition": `attachment; filename="${out.name}.html"`,
        });
        res.end(out.html);
      } catch (e) {
        if (e instanceof BuildQueueFullError) {
          res
            .writeHead(503, { "retry-after": "5" })
            .end(JSON.stringify({ error: "server busy, try again shortly" }));
          return;
        }
        res
          .writeHead(500)
          .end(
            JSON.stringify({
              error: String(e instanceof Error ? e.message : e),
            }),
          );
      }
      return;
    }

    if (url.pathname === "/api/sites") {
      if (!authorizeRead(req)) {
        res.writeHead(401).end(JSON.stringify({ error: "unauthorized" }));
        return;
      }
      res
        .writeHead(200, { "content-type": TYPES[".json"] })
        .end(JSON.stringify(listSites(hostingDir)));
      return;
    }

    // v3.0 marketplace browse: the registry store beside the hosting dir.
    if (url.pathname === "/api/registry") {
      if (!authorizeRead(req)) {
        res.writeHead(401).end(JSON.stringify({ error: "unauthorized" }));
        return;
      }
      const q = (url.searchParams.get("q") ?? "").toLowerCase();
      const plugins = loadRegistry(hostingDir).plugins.filter((p) =>
        !q ||
        [p.name, p.description ?? "", p.keywords?.join(" ") ?? "", p.kind]
          .join(" ")
          .toLowerCase()
          .includes(q),
      );
      res
        .writeHead(200, { "content-type": TYPES[".json"] })
        .end(JSON.stringify(plugins));
      return;
    }

    // v4.5 MCP over HTTP: the same three tools the stdio server speaks, served
    // against a deployed site's docmodel.json. A deployed site already serves
    // that artifact (the static path below); this adds the tool-shaped layer an
    // agent needs, so an agent can query a live site instead of a local file.
    // Guarded like the other reads: needsAuth gates it when auth is configured,
    // and a private site additionally requires its access token. The cross-site
    // POST check above applies too.
    if (url.pathname === "/mcp" && req.method === "POST") {
      const siteName = url.searchParams.get("site") ?? "";
      if (!siteName) {
        res
          .writeHead(400, { "content-type": TYPES[".json"] })
          .end(JSON.stringify({ error: "missing ?site=<subdomain>" }));
        return;
      }
      if (!authorizeRead(req)) {
        res.writeHead(401).end(JSON.stringify({ error: "unauthorized" }));
        return;
      }
      const manifest = readManifest(hostingDir, siteName);
      if (!manifest) {
        res
          .writeHead(404, { "content-type": TYPES[".json"] })
          .end(JSON.stringify({ error: "site not found" }));
        return;
      }
      if (
        manifest.visibility === "private" &&
        !requireSiteAccess(req, manifest, token, hostingDir)
      ) {
        res.writeHead(401).end(JSON.stringify({ error: "unauthorized" }));
        return;
      }
      const limited = limiter.check(clientKey(req, trustProxy));
      if (!limited.ok) {
        res
          .writeHead(429, { "retry-after": String(limited.retryAfterSec) })
          .end(JSON.stringify({ error: "rate limited", retryAfter: limited.retryAfterSec }));
        return;
      }
      let body = "";
      for await (const chunk of req) body += chunk;
      const docmodelFile = path.join(hostingDir, siteName, "docmodel.json");
      const out = handleMcpRequest(docmodelFile, body, (call: McpToolCall) =>
        stats.recordToolCall(siteName, call),
      );
      res.writeHead(out.status, { "content-type": TYPES[".json"] }).end(out.body);
      return;
    }

    // v4.5: the query gap — which symbols agents asked for and did not find.
    // Owner-facing; rolled up across sites unless ?site= narrows it.
    if (url.pathname === "/api/gap") {
      if (!authorizeRead(req)) {
        res.writeHead(401).end(JSON.stringify({ error: "unauthorized" }));
        return;
      }
      const site = url.searchParams.get("site") ?? undefined;
      const limit = Number(url.searchParams.get("limit")) || 20;
      res
        .writeHead(200, { "content-type": TYPES[".json"] })
        .end(JSON.stringify({ site: site ?? "*", gaps: stats.gapReport(site, limit) }));
      return;
    }

    // v3.5 federated search: ranked symbol hits across every indexed repo.
    // The store lives beside the hosting dir (same convention as .registry.json).
    if (url.pathname === "/api/search") {
      if (!authorizeRead(req)) {
        res.writeHead(401).end(JSON.stringify({ error: "unauthorized" }));
        return;
      }
      const q = url.searchParams.get("q") ?? "";
      if (!q.trim()) {
        res.writeHead(400).end(JSON.stringify({ error: "missing q" }));
        return;
      }
      const limit = Number(url.searchParams.get("limit")) || 20;
      const hits = searchFederation(loadFederation(hostingDir), q, { limit });
      res
        .writeHead(200, { "content-type": TYPES[".json"] })
        .end(JSON.stringify({ query: q, hits }));
      return;
    }

    if (url.pathname === "/api/markdown" && req.method === "POST") {
      const auth = authorize(req, "markdown");
      if (auth !== "ok") {
        deny(res, auth);
        return;
      }
      const limited = limiter.check(clientKey(req, trustProxy));
      if (!limited.ok) {
        res
          .writeHead(429, { "retry-after": String(limited.retryAfterSec) })
          .end(JSON.stringify({ error: "rate limited", retryAfter: limited.retryAfterSec }));
        return;
      }
      let body = "";
      for await (const chunk of req) body += chunk;
      let data: { source?: string; format?: "md" | "mdx"; name?: string };
      try {
        data = JSON.parse(body || "{}") as typeof data;
      } catch {
        res.writeHead(400).end(JSON.stringify({ error: "invalid json" }));
        return;
      }
      if (!data.source) {
        res.writeHead(400).end(JSON.stringify({ error: "missing source" }));
        return;
      }
      const guardedSource = guardSource(data.source, res);
      if (guardedSource === undefined) return;
      data.source = guardedSource;
      try {
        const out = await queue.enqueue(() => runMarkdown(data));
        res.writeHead(200, { "content-type": "text/markdown; charset=utf-8" }).end(out);
      } catch (e) {
        if (e instanceof BuildQueueFullError) {
          res
            .writeHead(503, { "retry-after": "5" })
            .end(JSON.stringify({ error: "server busy, try again shortly" }));
          return;
        }
        res
          .writeHead(500)
          .end(JSON.stringify({ error: String(e instanceof Error ? e.message : e) }));
      }
      return;
    }

    if (url.pathname === "/api/stats") {
      // v2.5 org rollup: authenticated owners see the org's view/build totals.
      const org = url.searchParams.get("org");
      if (org) {
        if (!authorizeRead(req)) {
          res.writeHead(401).end(JSON.stringify({ error: "unauthorized" }));
          return;
        }
        const sites = listOrgSites(hostingDir, org);
        const all = stats.get() as Record<string, { views: number; builds: number }>;
        res
          .writeHead(200, { "content-type": TYPES[".json"] })
          .end(JSON.stringify({ org, ...aggregateOrgStats(all, sites) }));
        return;
      }
      const site = url.searchParams.get("site");
      if (site) {
        const manifest = readManifest(hostingDir, site);
        if (
          manifest?.visibility === "private" &&
          !requireSiteAccess(req, manifest, token, hostingDir)
        ) {
          res
            .writeHead(401, { "content-type": TYPES[".json"] })
            .end(JSON.stringify({ error: "unauthorized" }));
          return;
        }
        const data = stats.get(site) as SiteStats;
        res
          .writeHead(200, { "content-type": TYPES[".json"] })
          .end(
            JSON.stringify({
              ...data,
              topPaths: stats.topPaths(site),
            }),
          );
        return;
      }
      if (!authorizeRead(req)) {
        res.writeHead(401).end(JSON.stringify({ error: "unauthorized" }));
        return;
      }
      res
        .writeHead(200, { "content-type": TYPES[".json"] })
        .end(JSON.stringify(stats.get()));
      return;
    }

    if (url.pathname === "/" || url.pathname === "/index.html") {
      // v2.5 custom domains: a verified domain serves its site at the root,
      // not the drop-in landing page — fall through to site resolution.
      if (!isCustomDomainHost(host, hostingDir)) {
        try {
          const html = readFileSync(DROPIN, "utf8");
          res.writeHead(200, { "content-type": TYPES[".html"] }).end(html);
        } catch {
          res
            .writeHead(200, { "content-type": TYPES[".html"] })
            .end(fallbackLanding(listSites(hostingDir)));
        }
        return;
      }
    }

    if (url.pathname === "/dashboard" && req.method === "GET") {
      const site = url.searchParams.get("site");
      if (!site) {
        res.writeHead(400, { "content-type": TYPES[".txt"] }).end("missing ?site=");
        return;
      }
      const manifest = readManifest(hostingDir, site);
      if (!manifest) {
        res.writeHead(404, { "content-type": TYPES[".txt"] }).end("site not found");
        return;
      }
      if (
        manifest.visibility === "private" &&
        draftExpired(manifest)
      ) {
        res
          .writeHead(410, { "content-type": TYPES[".txt"] })
          .end("Draft link expired — ask the owner to re-deploy or extend it.");
        return;
      }
      if (
        manifest.visibility === "private" &&
        !requireSiteAccess(req, manifest, token, hostingDir)
      ) {
        res
          .writeHead(401, { "content-type": TYPES[".txt"] })
          .end("Private site — provide ?token=<access> or Authorization: Bearer <access>");
        return;
      }
      const data = stats.get(site) as { views: number; builds: number };
      res
        .writeHead(200, { "content-type": TYPES[".html"] })
        .end(dashboardHtml(site, manifest, data, stats.topPaths(site)));
      return;
    }

    const site = resolveSite(url.pathname, host, hostingDir);
    if (!site) {
      res.writeHead(404, { "content-type": TYPES[".txt"] }).end("Not found");
      return;
    }

    const manifest = readManifest(hostingDir, site.subdomain);
    // v1.2 private drafts: an expired draft link is revoked for everyone
    // (admin token included) — re-deploy or extend to restore access.
    if (manifest?.draft && draftExpired(manifest)) {
      res
        .writeHead(410, { "content-type": TYPES[".txt"] })
        .end("Draft link expired — ask the owner to re-deploy or extend it.");
      return;
    }
    if (
      manifest?.visibility === "private" &&
      !requireSiteAccess(req, manifest, token, hostingDir)
    ) {
      res
        .writeHead(401, { "content-type": TYPES[".txt"] })
        .end(
          "Private site — provide ?token=<access> or Authorization: Bearer <access>",
        );
      return;
    }

    const ext = path.extname(site.filePath);
    // HTML is mutable (re-deploys) so never cache it; static assets can cache
    // briefly. A `?v=<token>` query (ignored by routing) lets deploys bust caches.
    const cache =
      ext === ".html"
        ? "no-cache"
        : "public, max-age=3600, stale-while-revalidate=86400";
    res.writeHead(200, {
      "content-type": TYPES[ext] ?? "application/octet-stream",
      "cache-control": cache,
    });

    if (ext === ".html") {
      let html = readFileSync(site.filePath, "utf8");
      // Only public sites get the live views chip (avoids leaking private counts).
      if (manifest?.visibility !== "private") {
        html = injectViewsChip(html, site.subdomain);
        stats.recordView(site.subdomain, url.pathname);
      }
      res.end(html);
    } else {
      // finding #21: resolveSite stats the file, but a re-deploy can replace it
      // between that check and this open. An unhandled 'error' on a stream is
      // an uncaught exception, so a vanished file must end the response, not
      // the process.
      const stream = fs.createReadStream(site.filePath);
      stream.on("error", () => {
        if (!res.headersSent) res.writeHead(404);
        res.destroy();
      });
      stream.pipe(res);
    }
  };

  /**
   * finding #21: last-resort guard for the whole route body. An async listener
   * that throws (a malformed URL, a broken socket during a body read, a bug in
   * any route) rejects with no handler and takes the process down. Requests
   * are untrusted input, so the process must survive any single one of them.
   * A response that already started is left alone — only the connection dies.
   */
  return async (req, res) => {
    try {
      await handle(req, res);
    } catch (e) {
      if (!res.headersSent) {
        try {
          res
            .writeHead(500, { "content-type": TYPES[".json"] })
            .end(JSON.stringify({ error: "internal error" }));
        } catch {
          /* socket already gone — nothing to answer on */
        }
      }
      // A client that walks away mid-request is routine, not an incident.
      const code = (e as NodeJS.ErrnoException)?.code;
      if (code !== "ECONNRESET" && !(e instanceof Error && e.message === "aborted")) {
        console.error(
          `brewdocs: request failed: ${e instanceof Error ? e.message : String(e)}`,
        );
      }
    }
  };
}

export function createServer(
  hostingDir: string,
  storage?: StorageAdapter,
  token?: string,
  protection?: ProtectionOptions,
): http.Server {
  return http.createServer(buildRequestHandler(hostingDir, storage, token, protection));
}

export interface TlsOptions {
  /** PEM certificate contents. */
  cert: string;
  /** PEM private-key contents. */
  key: string;
}

/**
 * v2.5 HTTPS hosting for custom domains: serves the same pipeline over TLS
 * with the operator's certificate (e.g. one issued for the custom domain).
 * Plain HTTP stays the default; this is opt-in via `serve --tls-cert/--tls-key`.
 */
export function createSecureServer(
  hostingDir: string,
  storage: StorageAdapter | undefined,
  token: string | undefined,
  protection: ProtectionOptions | undefined,
  tls: TlsOptions,
): https.Server {
  return https.createServer(
    { cert: tls.cert, key: tls.key },
    buildRequestHandler(hostingDir, storage, token, protection),
  );
}

/** Append a tiny self-updating views chip to a served page (public sites only). */
function injectViewsChip(html: string, subdomain: string): string {
  const safe = encodeURIComponent(subdomain).replace(/'/g, "%27");
  const chip = `<div id="brewdocs-views" title="Page views" style="position:fixed;bottom:12px;right:12px;z-index:9999;font:12px system-ui,sans-serif;background:#2b2118;color:#f6efe2;padding:4px 10px;border-radius:999px;box-shadow:0 2px 8px rgba(0,0,0,.25)">👁 …</div><script>
(function(){var s=document.getElementById('brewdocs-views');fetch('/api/stats?site=${safe}').then(function(r){return r.json();}).then(function(d){if(s)s.textContent='👁 '+(d.views||0)+' views';}).catch(function(){if(s)s.remove();});})();
</script>`;
  if (html.includes("</body>")) return html.replace("</body>", `${chip}</body>`);
  return html + chip;
}

/** Minimal owner-facing analytics view for a hosted site. */
function dashboardHtml(
  site: string,
  manifest: SiteManifest,
  data: { views: number; builds: number },
  topPaths: Array<{ path: string; views: number }> = [],
): string {
  const visibility = manifest.visibility ?? "public";
  const title = manifest.title ? escapeHtml(manifest.title) : site;
  const paths = topPaths.length
    ? `<h2>Top pages</h2><ul>${topPaths
        .map(
          (p) =>
            `<li><code>${escapeHtml(p.path)}</code> — ${p.views} view${p.views === 1 ? "" : "s"}</li>`,
        )
        .join("")}</ul>`
    : "";
  return `<!doctype html><html lang="en"><head><meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Stats — ${escapeHtml(site)} · BrewDocs</title>
<style>body{font-family:system-ui,sans-serif;max-width:680px;margin:3rem auto;padding:0 1rem;color:#2b2118}
h1{font-family:Georgia,serif}.card{display:flex;gap:2rem;margin:1.5rem 0}
.stat{background:#fffdf9;border:1px solid #e7ddd0;border-radius:12px;padding:1.2rem 1.6rem}
.stat .n{font-size:2.2rem;font-weight:700;color:#b5651d}.stat .l{color:#7a6a58;font-size:.85rem}
a{color:#b5651d}</style></head>
<body><h1>📊 ${title}</h1>
<p><code>${escapeHtml(site)}.brewdocs.dev</code> · ${visibility}${manifest.org ? " · org: " + escapeHtml(manifest.org) : ""}</p>
<div class="card">
  <div class="stat"><div class="n">${data.views}</div><div class="l">page views</div></div>
  <div class="stat"><div class="n">${data.builds}</div><div class="l">builds</div></div>
</div>
${paths}
<p><a href="/s/${encodeURIComponent(site)}/">View site ↗</a> · <a href="/">← BrewDocs</a></p>
</body></html>`;
}

async function runBuild(
  data: {
    source?: string;
    name?: string;
    theme?: string;
    dark?: boolean;
    org?: string;
    visibility?: Visibility;
    token?: string;
  },
  hostingDir: string,
  storage?: StorageAdapter,
): Promise<{ url: string; subdomain: string }> {
  const resolved = resolveInput(data.source!);
  try {
    const sub = subdomainFor(resolved.source, data.name, data.org);
    const opts: RenderOptions = { theme: data.theme, dark: !!data.dark };
    const result = await deploySite(
      resolved.source,
      hostingDir,
      sub,
      opts,
      storage,
      {
        org: data.org,
        visibility: data.visibility,
        token: data.token,
      },
    );
    return { url: result.url, subdomain: sub };
  } finally {
    resolved.cleanup();
  }
}

async function runExport(data: {
  source?: string;
  theme?: string;
  dark?: boolean;
  name?: string;
}): Promise<{ html: string; name: string }> {
  const resolved = resolveInput(data.source!);
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "brewdocs-export-"));
  try {
    const file = await exportSite(resolved.source, tmp, {
      theme: data.theme,
      dark: !!data.dark,
    });
    const html = readFileSync(file, "utf8");
    const name = subdomainFor(resolved.source, data.name) ?? "site";
    return { html, name };
  } finally {
    resolved.cleanup();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

async function runMarkdown(data: {
  source?: string;
  format?: "md" | "mdx";
  name?: string;
}): Promise<string> {
  const resolved = resolveInput(data.source!);
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "brewdocs-md-"));
  try {
    const file = await buildMarkdown(resolved.source, tmp, { format: data.format ?? "md" });
    return readFileSync(file, "utf8");
  } finally {
    resolved.cleanup();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}
