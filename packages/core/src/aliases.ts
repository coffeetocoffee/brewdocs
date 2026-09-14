import * as fs from "node:fs";
import * as path from "node:path";

/**
 * v3.0 version aliases, EOL marking and page redirects. A versioned site
 * (`build-all`) can publish stable URLs like `/latest/` that never drift:
 * alias pages are tiny meta-refresh documents (self-contained, no JS), so a
 * bookmark to `…/latest/` keeps working after every release. `eol:` versions
 * render a banner + switcher marker; `redirects:` keep moved pages alive.
 */

/** Filesystem-safe directory name for a version string (shared with build). */
export function dirSafe(version: string): string {
  return version.replace(/[^a-zA-Z0-9._-]/g, "_");
}

/** Normalize `v1.2.3` / `1.2.3` for comparisons. */
function bare(version: string): string {
  return version.replace(/^v/, "").trim();
}

/**
 * Is a version end-of-life per config? Exact match (with or without `v`)
 * or a `"1.x"` / `"1"` major pattern.
 */
export function isEolVersion(version: string, eol: string[] | undefined): boolean {
  if (!eol || eol.length === 0) return false;
  const v = bare(version);
  return eol.some((entry) => {
    const e = bare(String(entry));
    if (!e) return false;
    if (e === v) return true;
    const major = e.replace(/\.x$/i, "");
    if (/^\d+$/.test(major) && v.split(".")[0] === major) return true;
    return false;
  });
}

/** Minimal standalone meta-refresh page (no JS; works from file://). */
export function redirectHtml(target: string, label: string): string {
  const safe = target.replace(/"/g, "&quot;");
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta http-equiv="refresh" content="0; url=${safe}" />
<link rel="canonical" href="${safe}" />
<title>${label}</title>
<style>body{font:16px/1.6 system-ui,sans-serif;margin:3rem;text-align:center}a{color:#b5651d}</style>
</head>
<body>
<p>Redirecting to <a href="${safe}">${safe}</a>…</p>
</body>
</html>
`;
}

/**
 * Write alias directories (`<out>/<alias>/index.html` → `<version>/…`) for
 * every alias whose target version was actually built. Returns the files
 * written. Aliases pointing at missing versions are skipped (warn), never
 * fatal — a half-published alias beats a crashed build-all.
 */
export function emitAliasPages(
  outDir: string,
  builtVersions: string[],
  aliases: Record<string, string> | undefined,
  opts: { eol?: string[] } = {},
): string[] {
  const written: string[] = [];
  for (const [alias, target] of Object.entries(aliases ?? {})) {
    const safeAlias = dirSafe(alias);
    if (!safeAlias || safeAlias === "." || safeAlias === "..") continue;
    const hit = builtVersions.find((v) => bare(v) === bare(target));
    if (!hit) {
      console.warn(
        `[brewdocs] alias "${alias}" -> "${target}" skipped: version not built`,
      );
      continue;
    }
    const isEol = isEolVersion(hit, opts.eol);
    const aliasDir = path.join(outDir, safeAlias);
    fs.mkdirSync(aliasDir, { recursive: true });
    const file = path.join(aliasDir, "index.html");
    fs.writeFileSync(
      file,
      redirectHtml(`../${dirSafe(hit)}/index.html`, `${alias} → v${hit}${isEol ? " (EOL)" : ""}`),
      "utf8",
    );
    written.push(file);
  }
  return written;
}

/**
 * Write `redirects:` pages (old path → new path, both site-root-relative).
 * Works for single-version builds and versioned sites alike.
 */
export function emitRedirects(
  outDir: string,
  redirects: Record<string, string> | undefined,
): string[] {
  const written: string[] = [];
  for (const [from, to] of Object.entries(redirects ?? {})) {
    if (!from || !to) continue;
    const target = path.join(outDir, from);
    // Never let a redirect overwrite a real built page.
    if (fs.existsSync(target) && target.endsWith(".html")) {
      console.warn(`[brewdocs] redirect "${from}" skipped: file exists`);
      continue;
    }
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, redirectHtml(to, `moved → ${to}`), "utf8");
    written.push(target);
  }
  return written;
}
