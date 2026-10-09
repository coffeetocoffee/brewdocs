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
import { ALL_SCOPES, keysConfigured, keysStoreUnreadable, validateKey } from "./keys.js";
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

const MAX_QUERIES_PER_SITE = 250;
const MAX_QUERY_LEN = 256;
const MAX_PATHS_PER_SITE = 250;
const MAX_PATH_LEN = 256;
const FLUSH_DEBOUNCE_MS = 2000;

/**
 * v4.7 finding #28: the largest POST body any route will accept. Every body
 * here is a tiny JSON control message (a source string, one MCP call), so
 * 1 MiB is generous; before the cap, one unauthenticated POST could grow the
 * heap until the process died (and the old read loop concatenated strings,
 * quadratic on top). Exported so tests size bodies against the real cap.
 */
export const MAX_BODY_BYTES = 1024 * 1024;

/**
 * v4.7 finding #28: how long a refused body is drained for. The 413 is written
 * first; draining the rest briefly lets a well-behaved client actually read
 * that response — closing a socket with unread bytes queued makes the kernel
 * send RST, which discards it. The deadline keeps a hostile endless body from
 * pinning the connection open.
 */
const BODY_DRAIN_MS = 1000;

/** Per-site pageview/build/tool-call counters, persisted next to the hosting dir. */
export class StatsStore {
  private static instances = new Map<string, StatsStore>();
  private data = new Map<string, SiteStats>();
  private dirty = false;
  private saveTimer: NodeJS.Timeout | null = null;
  private file: string;
  private lastMtimeMs = 0;

  static for(file: string): StatsStore {
    const norm = path.resolve(file);
    let inst = StatsStore.instances.get(norm);
    if (!inst) {
      inst = new StatsStore(norm);
    } else {
      inst.reloadIfNeeded();
    }
    return inst;
  }

  static __clearInstancesForTest(): void {
    for (const inst of StatsStore.instances.values()) {
      inst.flush();
    }
    StatsStore.instances.clear();
  }

  constructor(file: string) {
    this.file = path.resolve(file);
    StatsStore.instances.set(this.file, this);
    this.load();
    if (typeof process !== "undefined" && typeof process.once === "function") {
      process.once("beforeExit", () => this.flush());
    }
  }

  private load(): void {
    if (!fs.existsSync(this.file)) return;
    try {
      const stat = fs.statSync(this.file);
      this.lastMtimeMs = stat.mtimeMs;
      const raw = JSON.parse(readFileSync(this.file, "utf8")) as Record<
        string,
        SiteStats
      >;
      if (raw && typeof raw === "object") {
        for (const [k, v] of Object.entries(raw)) this.data.set(k, v);
      }
    } catch (err) {
      console.error(
        `[brewdocs] analytics store unreadable (${this.file}) — starting with fresh store:`,
        err,
      );
    }
  }

  private reloadIfNeeded(): void {
    if (this.dirty || !fs.existsSync(this.file)) return;
    try {
      const stat = fs.statSync(this.file);
      if (stat.mtimeMs > this.lastMtimeMs) {
        this.load();
      }
    } catch {
      /* ignore stat error */
    }
  }

  private scheduleSave(): void {
    this.dirty = true;
    if (!this.saveTimer) {
      this.saveTimer = setTimeout(() => {
        this.saveTimer = null;
        if (this.dirty) {
          this.flush();
        }
      }, FLUSH_DEBOUNCE_MS);
      this.saveTimer.unref?.();
    }
  }

  private save(): void {
    this.scheduleSave();
  }

  flush(): void {
    if (this.saveTimer) {
      clearTimeout(this.saveTimer);
      this.saveTimer = null;
    }
    if (!this.dirty) return;
    this.dirty = false;
    this.writeToDisk();
  }

  private writeToDisk(): void {
    const dir = path.dirname(this.file);
    const tmp = path.join(
      dir,
      `.analytics.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2)}.tmp`,
    );
    try {
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(tmp, JSON.stringify(Object.fromEntries(this.data)), "utf8");
      try {
        fs.renameSync(tmp, this.file);
      } catch (renameErr: any) {
        if (renameErr && (renameErr.code === "EPERM" || renameErr.code === "EEXIST" || renameErr.code === "EBUSY")) {
          try {
            if (fs.existsSync(this.file)) fs.unlinkSync(this.file);
            fs.renameSync(tmp, this.file);
          } catch {
            fs.copyFileSync(tmp, this.file);
            fs.unlinkSync(tmp);
          }
        } else {
          throw renameErr;
        }
      }
      try {
        this.lastMtimeMs = fs.statSync(this.file).mtimeMs;
      } catch {
        /* best-effort */
      }
    } catch (err) {
      try {
        if (fs.existsSync(tmp)) fs.unlinkSync(tmp);
      } catch {
        /* best-effort cleanup */
      }
      console.error(`[brewdocs] failed to persist analytics to ${this.file}:`, err);
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
      const cleanPath = page.length > MAX_PATH_LEN ? page.slice(0, MAX_PATH_LEN) : page;
      if (!s.paths[cleanPath] && Object.keys(s.paths).length >= MAX_PATHS_PER_SITE) {
        const sorted = Object.entries(s.paths).sort((a, b) => b[1] - a[1]);
        s.paths = Object.fromEntries(sorted.slice(0, Math.floor(MAX_PATHS_PER_SITE * 0.8)));
      }
      s.paths[cleanPath] = (s.paths[cleanPath] ?? 0) + 1;
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

    const cleanQuery =
      typeof call.query === "string" && call.query.length > MAX_QUERY_LEN
        ? call.query.slice(0, MAX_QUERY_LEN)
        : String(call.query ?? "");
    const tool = String(call.tool ?? "");
    const key = `${tool}\u0000${cleanQuery}`;

    let row = s.queries[key];
    if (!row) {
      if (Object.keys(s.queries).length >= MAX_QUERIES_PER_SITE) {
        // Prune: keep top-N by misses (what gapReport ranks on anyway) and calls
        const sorted = Object.values(s.queries).sort(
          (a, b) => b.misses - a.misses || b.calls - a.calls || (b.lastAt > a.lastAt ? 1 : -1),
        );
        const keep = sorted.slice(0, Math.floor(MAX_QUERIES_PER_SITE * 0.8));
        s.queries = {};
        for (const r of keep) {
          s.queries[`${r.tool}\u0000${r.query}`] = r;
        }
      }
      row = {
        tool,
        query: cleanQuery,
        calls: 0,
        misses: 0,
        lastHits: 0,
        lastAt: "",
      };
    }
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
  const store = StatsStore.for(path.join(hostingDir, ".analytics.json"));
  store.flush();
  return store.gapReport(site, limit);
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

/**
 * v4.7 finding #29: resolve a numeric protection option from the explicit
 * value or an env var. Two channels, two trust levels:
 *
 *  - `value` is the embedding API (createServer callers, tests): taken as
 *    given while it is finite and >= 0. 0 stays legal there — a caller that
 *    writes `maxConcurrentBuilds: 0` is deliberately exercising the "no
 *    capacity" path.
 *  - `env` is operator config from a shell, a .env file or `docker run -e`,
 *    where 0 or an empty string is nearly always an accident, not an intent.
 *    It must be finite and >= opts.min (>= 1 for the rate limit, the window
 *    and build concurrency; >= 0 for queue depth, where 0 means "no queueing"
 *    and is a real choice). `Number("")` is 0 and `Number("-5")` is -5, so
 *    the old NaN-only check let `BREWDOCS_RATE_LIMIT=` through as "limit 0" —
 *    one request per window, which bricked every build route after one call —
 *    and a negative maxConcurrentBuilds pinned the queue forever. Unusable
 *    values warn (once per server construction) and fall back to the default:
 *    the same warn-and-drop contract config.ts applies to brewdocs.yml (D-8).
 */
export function numOption(
  value: number | undefined,
  env: string | undefined,
  fallback: number,
  opts: { min: number; name: string },
): number {
  if (value !== undefined) {
    if (Number.isFinite(value) && value >= 0) return value;
    console.warn(
      `[brewdocs] ${opts.name}=${value} is not usable (need a number >= 0) — using ${fallback}`,
    );
    return fallback;
  }
  if (env === undefined) return fallback;
  const parsed = env.trim() === "" ? NaN : Number(env);
  if (Number.isFinite(parsed) && parsed >= opts.min) return parsed;
  console.warn(
    `[brewdocs] ${opts.name}=${JSON.stringify(env)} is not usable (need a number >= ${opts.min}) — using ${fallback}`,
  );
  return fallback;
}

/**
 * v4.7 finding #28: answer 413 for a body over the cap. The response goes out
 * BEFORE the socket closes: destroying the request at refusal time races the
 * response write, and a socket closed with unread bytes queued makes the
 * kernel send RST, discarding the 413 the client never got to read (verified:
 * `req.destroy()` at refusal surfaced as ECONNRESET on every client). So the
 * refused body is drained for a short deadline — long enough for a
 * well-behaved client to read the answer, short enough that an endless body
 * cannot pin the connection — and the request is destroyed when it elapses.
 */
function refuseTooLarge(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  limit: number,
): void {
  res.writeHead(413, { "content-type": TYPES[".json"], connection: "close" });
  res.end(JSON.stringify({ error: "payload too large", limit }));
  const deadline = setTimeout(() => req.destroy(), BODY_DRAIN_MS);
  deadline.unref?.();
  req.once("end", () => clearTimeout(deadline));
  req.once("close", () => clearTimeout(deadline));
}

/**
 * v4.7 finding #28: the single capped reader for POST bodies — the four
 * routes used to each read the body unbounded into a string. A declared
 * content-length over the cap is refused before a byte is read; a chunked (or
 * lying) request is refused as soon as the running total crosses it, and the
 * remainder is drained, not accumulated, so the 413 still reaches the client.
 * Returns undefined once it has answered — callers just return.
 */
async function readBody(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  maxBytes = MAX_BODY_BYTES,
): Promise<string | undefined> {
  const declared = Number(req.headers["content-length"]);
  if (Number.isFinite(declared) && declared > maxBytes) {
    refuseTooLarge(req, res, maxBytes);
    req.resume();
    return undefined;
  }
  const chunks: Buffer[] = [];
  let total = 0;
  let refused = false;
  try {
    for await (const chunk of req) {
      total += chunk.length;
      if (total > maxBytes) {
        if (!refused) {
          refused = true;
          refuseTooLarge(req, res, maxBytes);
        }
        continue; // drain without accumulating; refuseTooLarge owns the deadline
      }
      chunks.push(chunk);
    }
  } catch (e) {
    // A client that walks away mid-body is routine (the outer guard tolerates
    // it) — but once the 413 is out, a drain-deadline destroy is expected,
    // not an incident to report.
    if (!refused) throw e;
    return undefined;
  }
  if (refused) return undefined;
  return Buffer.concat(chunks).toString("utf8");
}

/** readBody + JSON.parse, with the shared 400 for malformed JSON. */
async function readJsonBody<T>(
  req: http.IncomingMessage,
  res: http.ServerResponse,
): Promise<T | undefined> {
  const body = await readBody(req, res);
  if (body === undefined) return undefined;
  try {
    return JSON.parse(body || "{}") as T;
  } catch {
    res.writeHead(400).end(JSON.stringify({ error: "invalid json" }));
    return undefined;
  }
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

/**
 * Three-state site-manifest read. The states are load-bearing:
 *
 *   ok         — parsed; `visibility`, `tokenHash` and `draft` can be trusted.
 *   missing    — no manifest file. A hand-dropped directory is served as a
 *                public site on purpose (resolveSite gates on index.html).
 *                Whoever can delete this file can equally rewrite
 *                `visibility`, so absence is not a distinct weakness (D-12).
 *   unreadable — the file exists but could not be read or parsed. Callers must
 *                REFUSE, never fall through to "public": `requireSiteAccess`
 *                reads an absent `tokenHash` as public, and deploy writes the
 *                manifest with a non-atomic writeFileSync, so a crash or a
 *                full disk leaves a truncated file that used to silently
 *                publish a private site (finding #23).
 *
 * A non-slug subdomain answers `missing` — the same refusal routing gives
 * (resolveSite). The `?site=` routes pass caller-controlled strings here, and
 * this check is the chokepoint that keeps `../x` inside the hosting dir
 * (finding #24).
 */
type ManifestRead =
  | { state: "ok"; manifest: SiteManifest }
  | { state: "missing" }
  | { state: "unreadable"; detail: string };

function readManifest(hostingDir: string, subdomain: string): ManifestRead {
  if (!SAFE_SUBDOMAIN.test(subdomain)) return { state: "missing" };
  const file = path.join(hostingDir, subdomain, ".brewdocs.json");
  const unreadable = (detail: string): ManifestRead => {
    // The operator-facing half of finding #23: before this, a damaged manifest
    // was indistinguishable from a missing one, so the operator saw only
    // "site not found" while the site's real state was unknowable.
    console.error(`brewdocs: unreadable site manifest: ${file} (${detail})`);
    return { state: "unreadable", detail };
  };
  let raw: string;
  try {
    raw = readFileSync(file, "utf8");
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    // Absent is the one benign case; a permissions or I/O error is not.
    if (code === "ENOENT") return { state: "missing" };
    return unreadable(code ?? String(e));
  }
  try {
    const manifest = JSON.parse(raw) as SiteManifest;
    if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)) {
      return unreadable("not a JSON object");
    }
    return { state: "ok", manifest };
  } catch {
    return unreadable("invalid JSON");
  }
}

/**
 * Does the request prove access to a private site (or hold the admin token)?
 * v2.5: members of the site's org (any valid member key as the Bearer token)
 * can read that org's private docs — the org is the sharing group.
 *
 * A manifest that says `private` but carries no tokenHash is refused rather
 * than opened: deploy mints a token for every private site, so that state
 * means a hand-edited or truncated manifest, and answering "no hash, so
 * public" would publish the site its own manifest calls private (finding #25).
 */
function requireSiteAccess(
  req: http.IncomingMessage,
  manifest: SiteManifest | undefined,
  adminToken: string | undefined,
  hostingDir: string,
): boolean {
  if (adminToken && safeEqual(req.headers["authorization"] ?? "", `Bearer ${adminToken}`)) {
    return true;
  }
  const tokenHash = manifest?.tokenHash;
  if (!tokenHash && manifest?.visibility !== "private") return true;
  const provided =
    req.headers["authorization"]?.replace(/^Bearer\s+/i, "") ??
    new URL(req.url ?? "/", "http://localhost").searchParams.get("token") ??
    "";
  if (!provided) return false;
  if (tokenHash) {
    const hash = crypto.createHash("sha256").update(provided).digest("hex");
    if (safeEqual(hash, tokenHash)) return true;
  }
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
        const read = readManifest(hostingDir, d);
        const manifest = read.state === "ok" ? read.manifest : undefined;
        return {
          subdomain: d,
          url: `https://${d}.brewdocs.dev`,
          title: manifest?.title,
          org: manifest?.org,
          // An unreadable manifest must not be advertised as public; the site
          // it describes will refuse to serve until the file is repaired.
          visibility:
            read.state === "unreadable" ? "private" : manifest?.visibility ?? "public",
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
    numOption(protection?.rateLimit, process.env.BREWDOCS_RATE_LIMIT, 10, {
      min: 1,
      name: "BREWDOCS_RATE_LIMIT",
    }),
    numOption(protection?.rateWindowMs, process.env.BREWDOCS_RATE_WINDOW_MS, 60000, {
      min: 1,
      name: "BREWDOCS_RATE_WINDOW_MS",
    }),
  );
  const queue = new BuildQueue(
    numOption(protection?.maxConcurrentBuilds, process.env.BREWDOCS_MAX_BUILDS, 2, {
      min: 1,
      name: "BREWDOCS_MAX_BUILDS",
    }),
    numOption(protection?.maxQueue, process.env.BREWDOCS_MAX_QUEUE, 8, {
      min: 0,
      name: "BREWDOCS_MAX_QUEUE",
    }),
  );
  const stats = StatsStore.for(path.join(hostingDir, ".analytics.json"));
  // Require credentials once *some* auth is configured (admin token or
  // keys). finding #26: a key store that exists but is unreadable must count as
  // "auth IS configured" — `loadKeys` answers [] for a damaged file, and
  // reading that as "no auth" would open every gated endpoint at the exact
  // moment the operator's key store broke.
  //
  // finding #33: this is a function, not a value. Evaluated once at
  // construction it froze the decision for the process lifetime, so a key
  // issued while the server was running did not turn auth on — even though the
  // startup banner tells operators to run `brewdocs keys add` to lock a network
  // instance down. Re-read per request (a small JSON file), matching the
  // domains store, which is re-read per request for the same reason.
  // `authAnnounced` starts true when auth was already on at boot, so the
  // transition is announced exactly once, when a running server first refuses.
  let authAnnounced = Boolean(token) || keysConfigured(hostingDir);
  const needsAuthNow = (): boolean => {
    if (token) return true;
    const configured = keysConfigured(hostingDir);
    if (configured && !authAnnounced) {
      // Make the state legible: a running server that starts refusing because
      // a key appeared (or the store broke) otherwise looks like a bug.
      authAnnounced = true;
      console.error(
        `brewdocs: auth is now enforced (${path.join(hostingDir, ".keys.json")}) — requests without a valid key or token will be refused`,
      );
    }
    return configured;
  };
  if (keysStoreUnreadable(hostingDir)) {
    // Make the refusal legible: every gated route answers 401 until the store
    // is repaired, and without this line that looks like a broken credential.
    console.error(
      `brewdocs: key store unreadable (${path.join(hostingDir, ".keys.json")}) — treating auth as configured and refusing until it parses`,
    );
  }

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
    if (!needsAuthNow()) return "ok";
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
   * metadata. Auth is driven by the token OR configured keys, so when any auth
   * is configured these must not answer anonymously. With no auth at all they
   * stay open for local use (the drop-in UI reads them).
   *
   * finding #33: re-evaluated per request, so a key issued against a running
   * server takes effect immediately (and the startup banner's advice — "run
   * `brewdocs keys add`" — is finally true).
   */
  const authorizeRead = (req: http.IncomingMessage): boolean => {
    if (!needsAuthNow()) return true;
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

      const data = await readJsonBody<{
        source?: string;
        name?: string;
        theme?: string;
        dark?: boolean;
        org?: string;
        visibility?: Visibility;
        token?: string;
      }>(req, res);
      if (data === undefined) return;
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

      const data = await readJsonBody<{
        source?: string;
        theme?: string;
        dark?: boolean;
        name?: string;
      }>(req, res);
      if (data === undefined) return;
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
    // Guarded like the other reads: auth gates it when auth is configured,
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
      const read = readManifest(hostingDir, siteName);
      // finding #23: a damaged manifest must refuse, not answer "not found"
      // and not fall through to public. finding #24: readManifest's slug
      // check makes `?site=../x` answer missing here, so the docmodel path
      // below can never leave the hosting dir.
      if (read.state === "unreadable") {
        res
          .writeHead(500, { "content-type": TYPES[".json"] })
          .end(JSON.stringify({ error: "site manifest unreadable" }));
        return;
      }
      if (read.state === "missing") {
        res
          .writeHead(404, { "content-type": TYPES[".json"] })
          .end(JSON.stringify({ error: "site not found" }));
        return;
      }
      const manifest = read.manifest;
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
      const body = await readBody(req, res);
      if (body === undefined) return;
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
      const data = await readJsonBody<{ source?: string; format?: "md" | "mdx"; name?: string }>(
        req,
        res,
      );
      if (data === undefined) return;
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
        if (!SAFE_SUBDOMAIN.test(site)) {
          res
            .writeHead(400, { "content-type": TYPES[".json"] })
            .end(JSON.stringify({ error: "invalid site name" }));
          return;
        }
        const read = readManifest(hostingDir, site);
        // finding #23: an unreadable manifest means the site's visibility is
        // unknowable, so the stats must not answer as if it were public.
        // finding #24: a non-slug site answers missing here (readManifest),
        // and a missing site keeps its historical empty-stats answer.
        if (read.state === "unreadable") {
          res
            .writeHead(500, { "content-type": TYPES[".json"] })
            .end(JSON.stringify({ error: "site manifest unreadable" }));
          return;
        }
        const manifest = read.state === "ok" ? read.manifest : undefined;
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
      const read = readManifest(hostingDir, site);
      // finding #23: damaged manifest refuses. finding #24: a non-slug site
      // (`../x`) answers missing, so the dashboard can never render another
      // directory's manifest title.
      if (read.state === "unreadable") {
        res
          .writeHead(500, { "content-type": TYPES[".txt"] })
          .end("site manifest unreadable");
        return;
      }
      if (read.state === "missing") {
        res.writeHead(404, { "content-type": TYPES[".txt"] }).end("site not found");
        return;
      }
      const manifest = read.manifest;
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

    const read = readManifest(hostingDir, site.subdomain);
    // finding #23: a damaged manifest refuses instead of serving the site as
    // public. A MISSING manifest keeps serving (hand-dropped directory, D-12):
    // whoever can delete this file can equally rewrite its visibility, so
    // absence is not the weakness — an unreadable file is, because it means
    // the file's real contents are unknown, not that they say "public".
    if (read.state === "unreadable") {
      res
        .writeHead(500, { "content-type": TYPES[".txt"] })
        .end("site manifest unreadable — repair or redeploy this site");
      return;
    }
    const manifest = read.state === "ok" ? read.manifest : undefined;
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
  const server = http.createServer(buildRequestHandler(hostingDir, storage, token, protection));
  server.on("close", () => {
    StatsStore.for(path.join(hostingDir, ".analytics.json")).flush();
  });
  return server;
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
  const server = https.createServer(
    { cert: tls.cert, key: tls.key },
    buildRequestHandler(hostingDir, storage, token, protection),
  );
  server.on("close", () => {
    StatsStore.for(path.join(hostingDir, ".analytics.json")).flush();
  });
  return server;
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
