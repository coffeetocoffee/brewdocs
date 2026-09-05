import * as http from "node:http";
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import {
  combineSubdomain,
  deploySite,
  deriveSubdomain,
  exportSite,
  buildMarkdown,
  resolveInput,
  type RenderOptions,
  type Source,
  type StorageAdapter,
  type Visibility,
} from "@brewdocs/core";
import { readFileSync } from "node:fs";

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
  url?: string;
  title?: string;
  generatedAt?: string;
  pages?: number;
}

interface SiteStats {
  views: number;
  builds: number;
  lastViewed?: string;
  lastBuild?: string;
}

/** Per-site pageview/build counters, persisted next to the hosting dir. */
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
  recordView(sub: string): void {
    const s = this.data.get(sub) ?? { views: 0, builds: 0 };
    s.views++;
    s.lastViewed = new Date().toISOString();
    this.data.set(sub, s);
    this.save();
  }
  get(sub?: string): SiteStats | Record<string, SiteStats> {
    if (sub) return this.data.get(sub) ?? { views: 0, builds: 0 };
    return Object.fromEntries(this.data);
  }
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

function clientKey(req: http.IncomingMessage): string {
  const fwd = req.headers["x-forwarded-for"];
  if (typeof fwd === "string" && fwd.length) return fwd.split(",")[0].trim();
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

/** Does the request prove access to a private site (or hold the admin token)? */
function requireSiteAccess(
  req: http.IncomingMessage,
  tokenHash: string | undefined,
  adminToken: string | undefined,
): boolean {
  if (!tokenHash) return true;
  if (adminToken && req.headers["authorization"] === `Bearer ${adminToken}`) {
    return true;
  }
  const provided =
    req.headers["authorization"]?.replace(/^Bearer\s+/i, "") ??
    new URL(req.url ?? "/", "http://localhost").searchParams.get("token") ??
    "";
  if (!provided) return false;
  const hash = crypto.createHash("sha256").update(provided).digest("hex");
  return hash === tokenHash;
}

/**
 * Map a request to a hosted site file, supporting both:
 *   - path routing:  /s/<subdomain>/<rest>
 *   - host routing:  <subdomain>.brewdocs.dev/<rest>
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
    if (subMatch) sub = subMatch[1];
  }

  if (!sub) return null;
  const base = path.resolve(hostingDir, sub);
  const filePath = path.join(base, rest);
  if (!filePath.startsWith(base)) return null;
  if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) return null;
  return { subdomain: sub, filePath };
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

export function createServer(
  hostingDir: string,
  storage?: StorageAdapter,
  token?: string,
  protection?: ProtectionOptions,
): http.Server {
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

  const requireAuth = (req: http.IncomingMessage): boolean => {
    if (!token) return true;
    const header = req.headers["authorization"] ?? "";
    return header === `Bearer ${token}`;
  };

  return http.createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const host = req.headers.host;

    if (url.pathname === "/api/build" && req.method === "POST") {
      if (!requireAuth(req)) {
        res.writeHead(401).end(JSON.stringify({ error: "unauthorized" }));
        return;
      }
      const limited = limiter.check(clientKey(req));
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
      if (!requireAuth(req)) {
        res.writeHead(401).end(JSON.stringify({ error: "unauthorized" }));
        return;
      }
      const limited = limiter.check(clientKey(req));
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
      res
        .writeHead(200, { "content-type": TYPES[".json"] })
        .end(JSON.stringify(listSites(hostingDir)));
      return;
    }

    if (url.pathname === "/api/markdown" && req.method === "POST") {
      if (!requireAuth(req)) {
        res.writeHead(401).end(JSON.stringify({ error: "unauthorized" }));
        return;
      }
      const limited = limiter.check(clientKey(req));
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
      const site = url.searchParams.get("site");
      if (site) {
        const manifest = readManifest(hostingDir, site);
        if (
          manifest?.visibility === "private" &&
          !requireSiteAccess(req, manifest.tokenHash, token)
        ) {
          res
            .writeHead(401, { "content-type": TYPES[".json"] })
            .end(JSON.stringify({ error: "unauthorized" }));
          return;
        }
        res
          .writeHead(200, { "content-type": TYPES[".json"] })
          .end(JSON.stringify(stats.get(site)));
        return;
      }
      if (!requireAuth(req)) {
        res.writeHead(401).end(JSON.stringify({ error: "unauthorized" }));
        return;
      }
      res
        .writeHead(200, { "content-type": TYPES[".json"] })
        .end(JSON.stringify(stats.get()));
      return;
    }

    if (url.pathname === "/" || url.pathname === "/index.html") {
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
        !requireSiteAccess(req, manifest.tokenHash, token)
      ) {
        res
          .writeHead(401, { "content-type": TYPES[".txt"] })
          .end("Private site — provide ?token=<access> or Authorization: Bearer <access>");
        return;
      }
      const data = stats.get(site) as { views: number; builds: number };
      res
        .writeHead(200, { "content-type": TYPES[".html"] })
        .end(dashboardHtml(site, manifest, data));
      return;
    }

    const site = resolveSite(url.pathname, host, hostingDir);
    if (!site) {
      res.writeHead(404, { "content-type": TYPES[".txt"] }).end("Not found");
      return;
    }

    const manifest = readManifest(hostingDir, site.subdomain);
    if (
      manifest?.visibility === "private" &&
      !requireSiteAccess(req, manifest.tokenHash, token)
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
        stats.recordView(site.subdomain);
      }
      res.end(html);
    } else {
      fs.createReadStream(site.filePath).pipe(res);
    }
  });
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
): string {
  const visibility = manifest.visibility ?? "public";
  const title = manifest.title ? escapeText(manifest.title) : site;
  return `<!doctype html><html lang="en"><head><meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Stats — ${escapeText(site)} · BrewDocs</title>
<style>body{font-family:system-ui,sans-serif;max-width:680px;margin:3rem auto;padding:0 1rem;color:#2b2118}
h1{font-family:Georgia,serif}.card{display:flex;gap:2rem;margin:1.5rem 0}
.stat{background:#fffdf9;border:1px solid #e7ddd0;border-radius:12px;padding:1.2rem 1.6rem}
.stat .n{font-size:2.2rem;font-weight:700;color:#b5651d}.stat .l{color:#7a6a58;font-size:.85rem}
a{color:#b5651d}</style></head>
<body><h1>📊 ${title}</h1>
<p><code>${escapeText(site)}.brewdocs.dev</code> · ${visibility}${manifest.org ? " · org: " + escapeText(manifest.org) : ""}</p>
<div class="card">
  <div class="stat"><div class="n">${data.views}</div><div class="l">page views</div></div>
  <div class="stat"><div class="n">${data.builds}</div><div class="l">builds</div></div>
</div>
<p><a href="/s/${encodeURIComponent(site)}/">View site ↗</a> · <a href="/">← BrewDocs</a></p>
</body></html>`;
}

function escapeText(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
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
