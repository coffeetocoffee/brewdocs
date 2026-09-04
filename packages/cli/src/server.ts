import * as http from "node:http";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import {
  deploySite,
  deriveSubdomain,
  exportSite,
  resolveInput,
  type RenderOptions,
  type Source,
  type StorageAdapter,
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

export interface ServeOptions {
  hostingDir: string;
  port: number;
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

function subdomainFor(resolved: Source, requested?: string): string {
  const base = requested ?? packageName(resolved.root) ?? resolved.name;
  return deriveSubdomain({ root: resolved.root, name: base });
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

function listSites(hostingDir: string): Array<{ subdomain: string; url: string; title?: string }> {
  try {
    return fs
      .readdirSync(hostingDir)
      .filter((d) => fs.existsSync(path.join(hostingDir, d, "index.html")))
      .map((d) => {
        const manifestPath = path.join(hostingDir, d, ".brewdocs.json");
        let title: string | undefined;
        try {
          title = JSON.parse(readFileSync(manifestPath, "utf8")).title;
        } catch {
          /* ignore */
        }
        return { subdomain: d, url: `https://${d}.brewdocs.dev`, title };
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
): http.Server {
  fs.mkdirSync(hostingDir, { recursive: true });

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

      let body = "";
      for await (const chunk of req) body += chunk;
      try {
        const data = JSON.parse(body || "{}") as {
          source?: string;
          name?: string;
          theme?: string;
          dark?: boolean;
        };
        if (!data.source) {
          res.writeHead(400).end(JSON.stringify({ error: "missing source" }));
          return;
        }
        const resolved = resolveInput(data.source);
        const sub = subdomainFor(resolved.source, data.name);
        const opts: RenderOptions = { theme: data.theme, dark: !!data.dark };
        const result = await deploySite(
          resolved.source,
          hostingDir,
          sub,
          opts,
          storage,
        );
        resolved.cleanup();
        res
          .writeHead(200, { "content-type": TYPES[".json"] })
          .end(JSON.stringify({ url: result.url, subdomain: sub }));
      } catch (e) {
        res
          .writeHead(500)
          .end(JSON.stringify({ error: String(e instanceof Error ? e.message : e) }));
      }
      return;
    }

    if (url.pathname === "/api/export" && req.method === "POST") {
      if (!requireAuth(req)) {
        res.writeHead(401).end(JSON.stringify({ error: "unauthorized" }));
        return;
      }

      let body = "";
      for await (const chunk of req) body += chunk;
      let tmp: string | undefined;
      try {
        const data = JSON.parse(body || "{}") as {
          source?: string;
          theme?: string;
          dark?: boolean;
          name?: string;
        };
        if (!data.source) {
          res.writeHead(400).end(JSON.stringify({ error: "missing source" }));
          return;
        }
        const resolved = resolveInput(data.source);
        tmp = fs.mkdtempSync(path.join(os.tmpdir(), "brewdocs-export-"));
        const file = await exportSite(resolved.source, tmp, {
          theme: data.theme,
          dark: !!data.dark,
        });
        resolved.cleanup();
        const html = readFileSync(file, "utf8");
        const name = subdomainFor(resolved.source, data.name) ?? "site";
        res.writeHead(200, {
          "content-type": TYPES[".html"],
          "content-disposition": `attachment; filename="${name}.html"`,
        });
        res.end(html);
      } catch (e) {
        res
          .writeHead(500)
          .end(JSON.stringify({ error: String(e instanceof Error ? e.message : e) }));
      } finally {
        if (tmp) fs.rmSync(tmp, { recursive: true, force: true });
      }
      return;
    }

    if (url.pathname === "/api/sites") {
      res
        .writeHead(200, { "content-type": TYPES[".json"] })
        .end(JSON.stringify(listSites(hostingDir)));
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

    const site = resolveSite(url.pathname, host, hostingDir);
    if (!site) {
      res.writeHead(404, { "content-type": TYPES[".txt"] }).end("Not found");
      return;
    }
    const ext = path.extname(site.filePath);
    res.writeHead(200, { "content-type": TYPES[ext] ?? "application/octet-stream" });
    fs.createReadStream(site.filePath).pipe(res);
  });
}
