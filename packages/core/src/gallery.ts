import * as fs from "node:fs";
import * as path from "node:path";
import { build } from "./build.js";
import type { RenderOptions, Source } from "./types.js";

export interface GalleryEntry {
  name: string;
  root: string;
}

function galleryPage(entries: GalleryEntry[]): string {
  const items = entries
    .map(
      (e) =>
        `<li><a href="./${encodeURIComponent(e.name)}/"><span class="g-name">${e.name}</span></a>
        <span class="g-note">docs brewed by BrewDocs</span></li>`,
    )
    .join("\n");
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>BrewDocs Gallery</title>
<style>
  :root { --bg:#fbf7f0; --ink:#2b2118; --muted:#7a6a58; --accent:#b5651d; --card:#fffdf9; --line:#e7ddd0; }
  * { box-sizing: border-box; }
  body { margin:0; background:var(--bg); color:var(--ink); font:16px/1.6 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif; }
  header { padding:2.5rem 1.5rem; text-align:center; border-bottom:1px solid var(--line); background:linear-gradient(180deg,var(--card),var(--bg)); }
  .cup { font-size:2rem; }
  h1 { margin:0.25rem 0 0; font-family:Georgia,serif; }
  main { max-width:760px; margin:0 auto; padding:2rem 1.5rem 4rem; }
  ul { list-style:none; padding:0; margin:0; display:grid; gap:0.75rem; }
  li { display:flex; justify-content:space-between; align-items:baseline; gap:1rem; padding:1rem 1.1rem; border:1px solid var(--line); border-radius:12px; background:var(--card); }
  li a { text-decoration:none; color:var(--accent); font-weight:600; font-size:1.1rem; }
  .g-note { color:var(--muted); font-size:0.85rem; }
  footer { text-align:center; color:var(--muted); padding:2rem; font-size:0.85rem; }
  footer a { color:var(--accent); }
</style>
</head>
<body>
<header><div class="cup">☕</div><h1>BrewDocs Gallery</h1>
<p class="tag">Every one of these pages was brewed by BrewDocs.</p></header>
<main>
  <ul>${items}</ul>
</main>
<footer>Brewed with <a href="#">BrewDocs</a> — Brew your docs, serve them hot.</footer>
</body>
</html>`;
}

/**
 * Build an examples gallery: each entry becomes `<outDir>/<name>/index.html`,
 * plus a root `<outDir>/index.html` listing them. Useful as a self-hosted
 * showcase ("docs for BrewDocs, written in BrewDocs").
 */
export function buildGallery(
  entries: GalleryEntry[],
  outDir: string,
  options: RenderOptions = {},
): string {
  for (const entry of entries) {
    const src: Source = { root: entry.root, name: entry.name };
    build(src, path.join(outDir, entry.name), options);
  }
  const idx = path.join(outDir, "index.html");
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(idx, galleryPage(entries), "utf8");
  return idx;
}
