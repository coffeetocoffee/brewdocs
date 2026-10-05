import * as fs from "node:fs";
import * as path from "node:path";
import type { RenderModel } from "./types.js";
import { escapeHtml } from "./escape.js";

/**
 * Static-host deploy artifacts. BrewDocs output is a plain directory of HTML;
 * rather than run our own hosting control plane, emit the small files that
 * Netlify/Cloudflare Pages already understand so the CDN does the real work.
 */

/** Netlify/Cloudflare `_redirects`: `/old  /new  301`. */
function toPath(p: string): string {
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(p)) return p; // external URL: leave as-is
  const stripped = p.replace(/^\.?\//, "");
  return `/${stripped}`;
}

function notFoundHtml(title: string): string {
  const t = escapeHtml(title);
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="description" content="Page not found in the ${t} docs.">
<meta name="generator" content="BrewDocs">
<meta property="og:title" content="404 — ${t}">
<meta property="og:description" content="Page not found in the ${t} docs.">
<title>404 — ${t}</title>
<style>body{font:16px/1.6 system-ui,sans-serif;max-width:40rem;margin:15vh auto;padding:0 1.5rem;color:#2b2118}a{color:#8a5a2b}</style>
</head>
<body>
<h1>404</h1>
<p>That page was not found in the <strong>${t}</strong> docs.</p>
<p><a href="/">← Back to the docs</a></p>
</body>
</html>
`;
}

const HEADERS = `/*
  X-Content-Type-Options: nosniff
  Referrer-Policy: no-referrer

/*.html
  Cache-Control: no-cache
`;

/**
 * Emit `404.html`, `_headers` and (when `redirects:` is configured)
 * `_redirects` next to the built pages. Returns the written paths.
 *
 * @param outDir - built site root where the deploy artifacts are written.
 * @param model - render model supplying the site title for the 404 page.
 * @param redirects - old-to-new path map that becomes `_redirects`, when non-empty.
 * @returns the paths of the artifact files written.
 */
export function emitDeployArtifacts(
  outDir: string,
  model: RenderModel,
  redirects: Record<string, string> | undefined,
): string[] {
  fs.mkdirSync(outDir, { recursive: true });
  const written: string[] = [];
  const write = (name: string, body: string): void => {
    const file = path.join(outDir, name);
    fs.writeFileSync(file, body, "utf8");
    written.push(file);
  };

  write("404.html", notFoundHtml(model.title));
  write("_headers", HEADERS);

  const lines = Object.entries(redirects ?? {})
    .filter(([from, to]) => Boolean(from && to))
    .map(([from, to]) => `${toPath(from)}  ${toPath(to)}  301`);
  if (lines.length > 0) write("_redirects", lines.join("\n") + "\n");

  return written;
}
