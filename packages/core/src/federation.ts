import * as fs from "node:fs";
import * as path from "node:path";
import { loadDocModel } from "./mcp.js";
import type { DocModelArtifact } from "./docmodel.js";

/**
 * v3.5 cross-repo federated search (local control-plane, same spirit as
 * registry.ts/cloud.ts): one JSON store `<storeDir>/.federation.json` indexes
 * the `docmodel.json` of every registered repo, so a query searches all of
 * them at once. `federate add|search|page` + server `GET /api/search`.
 * No network: repos are indexed from local docmodel.json files.
 */

export interface FederationSymbol {
  name: string;
  kind: string;
  signature?: string;
  description?: string;
  /** Deep link into the repo's built site (set when `--url` was given). */
  url?: string;
}

export interface FederationRepo {
  /** Display name. */
  name: string;
  /** Filesystem/URL-safe slug (derived from the name). */
  slug: string;
  version?: string;
  description?: string;
  /** Where the docmodel.json was read from (local path). */
  source: string;
  gitSha?: string;
  /** When the artifact was generated (from the docmodel freshness stamp). */
  generatedAt?: string;
  /** When this repo was added/re-indexed. */
  indexedAt: string;
  /** Base URL the symbol `url`s are built from (optional). */
  url?: string;
  symbols: FederationSymbol[];
}

export interface FederationStore {
  repos: FederationRepo[];
}

const STORE_FILE = ".federation.json";

function storeFile(storeDir: string): string {
  return path.join(storeDir, STORE_FILE);
}

export function loadFederation(storeDir: string): FederationStore {
  try {
    const raw = JSON.parse(fs.readFileSync(storeFile(storeDir), "utf8")) as FederationStore;
    if (raw && Array.isArray(raw.repos)) return raw;
  } catch {
    /* fresh store */
  }
  return { repos: [] };
}

function saveFederation(storeDir: string, store: FederationStore): void {
  fs.mkdirSync(storeDir, { recursive: true });
  fs.writeFileSync(storeFile(storeDir), JSON.stringify(store, null, 2), "utf8");
}

export function slug(name: string): string {
  return name
    .toLowerCase()
    .replace(/^@/, "")
    .replace(/\//g, "-")
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/** Resolve a file or directory to its docmodel.json path. */
export function resolveDocModelPath(input: string): string | null {
  const abs = path.resolve(input);
  try {
    if (fs.statSync(abs).isDirectory()) {
      const file = path.join(abs, "docmodel.json");
      return fs.existsSync(file) ? file : null;
    }
    return fs.existsSync(abs) ? abs : null;
  } catch {
    return null;
  }
}

function symbolsOf(
  artifact: DocModelArtifact,
  url?: string,
): FederationSymbol[] {
  return artifact.symbols.map((s) => ({
    name: s.name,
    kind: s.kind,
    signature: s.signature,
    description: s.description,
    url: url ? `${url.replace(/\/+$/, "")}/#symbol-${encodeURIComponent(s.name)}` : undefined,
  }));
}

export interface AddRepoOptions {
  /** Base URL of the repo's built site; symbol deep links are derived from it. */
  url?: string;
}

/**
 * Add or re-index a repo from its `docmodel.json` (file or directory). A
 * re-add replaces the entry in place — same-name repos never duplicate.
 * Returns null (with a warning) when the file is missing or invalid.
 */
export function addFederatedRepo(
  storeDir: string,
  name: string,
  docmodelInput: string,
  opts: AddRepoOptions = {},
): FederationRepo | null {
  const file = resolveDocModelPath(docmodelInput);
  if (!file) {
    console.warn(
      `[brewdocs] federate: no docmodel.json at "${docmodelInput}" — run \`brewdocs build <src> --out <dir>\` first`,
    );
    return null;
  }
  let artifact: DocModelArtifact;
  try {
    ({ artifact } = loadDocModel(file));
  } catch (err) {
    console.warn(
      `[brewdocs] federate: ${file} is not a valid DocModel: ${
        err instanceof Error ? err.message : err
      }`,
    );
    return null;
  }
  const s = slug(name);
  if (!s) {
    console.warn(`[brewdocs] federate: name "${name}" is empty after slugging`);
    return null;
  }
  const store = loadFederation(storeDir);
  const record: FederationRepo = {
    name,
    slug: s,
    version: artifact.version ?? artifact.package?.version,
    description: artifact.description ?? artifact.package?.description,
    source: file,
    gitSha: artifact.source?.gitSha,
    generatedAt: artifact.generatedAt,
    indexedAt: new Date().toISOString(),
    url: opts.url,
    symbols: symbolsOf(artifact, opts.url),
  };
  const existing = store.repos.findIndex((r) => r.slug === s);
  if (existing >= 0) store.repos[existing] = record;
  else store.repos.push(record);
  store.repos.sort((a, b) => a.slug.localeCompare(b.slug));
  saveFederation(storeDir, store);
  return record;
}

export function listFederatedRepos(storeDir: string): FederationRepo[] {
  return loadFederation(storeDir).repos.slice();
}

export function removeFederatedRepo(storeDir: string, name: string): boolean {
  const store = loadFederation(storeDir);
  const s = slug(name);
  const before = store.repos.length;
  store.repos = store.repos.filter((r) => r.slug !== s);
  if (store.repos.length === before) return false;
  saveFederation(storeDir, store);
  return true;
}

export interface FederatedHit {
  repo: string;
  slug: string;
  repoUrl?: string;
  name: string;
  kind: string;
  signature?: string;
  description?: string;
  url?: string;
  score: number;
}

/**
 * Ranked search across every indexed repo. Scoring mirrors the in-page
 * search: symbol-name hits dominate (5/term), body hits add up (capped), and
 * the repo name rides in the body so "acme" surfaces acme's symbols.
 */
export function searchFederation(
  store: FederationStore,
  query: string,
  opts: { limit?: number } = {},
): FederatedHit[] {
  const limit = opts.limit ?? 20;
  const q = query.toLowerCase().trim();
  if (!q) return [];
  const terms = q.split(/\s+/);
  const hits: FederatedHit[] = [];
  for (const repo of store.repos) {
    for (const sym of repo.symbols) {
      const title = sym.name.toLowerCase();
      const body = [sym.description ?? "", sym.signature ?? "", repo.name]
        .join(" ")
        .toLowerCase();
      let score = 0;
      for (const t of terms) {
        if (title.includes(t)) score += 5;
        // Cap per-term body hits so a long description can't drown name hits.
        let from = 0;
        let count = 0;
        for (;;) {
          const idx = body.indexOf(t, from);
          if (idx < 0) break;
          count++;
          from = idx + t.length;
          if (count >= 10) break;
        }
        score += count;
      }
      if (score > 0) {
        hits.push({
          repo: repo.name,
          slug: repo.slug,
          repoUrl: repo.url,
          name: sym.name,
          kind: sym.kind,
          signature: sym.signature,
          description: sym.description,
          url: sym.url,
          score,
        });
      }
    }
  }
  hits.sort(
    (a, b) =>
      b.score - a.score ||
      a.repo.localeCompare(b.repo) ||
      a.name.localeCompare(b.name),
  );
  return hits.slice(0, limit);
}

/**
 * Standalone federated-search page (theme-free like gallery.ts): embeds the
 * whole index and searches client-side, so the page works offline from
 * file:// with zero dependencies. Returns the written index.html path.
 */
export function buildFederatedPage(storeDir: string, outDir: string): string {
  const store = loadFederation(storeDir);
  const symbolCount = store.repos.reduce((n, r) => n + r.symbols.length, 0);
  const esc = (s: string) =>
    s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  // JSON in a <script> tag: close-tag sequences must not terminate the block.
  const indexJson = JSON.stringify(
    store.repos.map((r) => ({
      repo: r.name,
      slug: r.slug,
      url: r.url,
      symbols: r.symbols.map((s) => ({
        n: s.name,
        k: s.kind,
        s: s.signature,
        d: s.description,
        u: s.url,
      })),
    })),
  ).replace(/<\//g, "<\\/");
  const repoList = store.repos
    .map(
      (r) =>
        `<li><span class="r-name">${esc(r.name)}</span>${
          r.version ? `<span class="r-ver">v${esc(r.version)}</span>` : ""
        }<span class="r-count">${r.symbols.length} symbol(s)</span></li>`,
    )
    .join("\n");
  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<meta name="description" content="Federated search across every repo indexed by BrewDocs." />
<meta name="generator" content="brewdocs" />
<title>BrewDocs Federated Search</title>
<style>
  :root { --bg:#fbf7f0; --ink:#2b2118; --muted:#7a6a58; --accent:#b5651d; --card:#fffdf9; --line:#e7ddd0; }
  * { box-sizing: border-box; }
  body { margin:0; background:var(--bg); color:var(--ink); font:16px/1.6 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif; }
  header { padding:2.5rem 1.5rem; text-align:center; border-bottom:1px solid var(--line); }
  h1 { margin:0.25rem 0 0; font-family:Georgia,serif; }
  main { max-width:860px; margin:0 auto; padding:2rem 1.5rem 4rem; }
  #q { width:100%; padding:0.8rem 1rem; font-size:1rem; border:1px solid var(--line); border-radius:10px; background:var(--card); color:var(--ink); }
  #q:focus { outline:2px solid var(--accent); }
  #results { list-style:none; padding:0; margin:1.25rem 0 0; }
  #results li { border:1px solid var(--line); border-radius:10px; background:var(--card); padding:0.75rem 1rem; margin-bottom:0.6rem; }
  .hit-head { display:flex; justify-content:space-between; align-items:baseline; gap:0.5rem; }
  .hit-name { font-weight:700; color:var(--accent); text-decoration:none; }
  .hit-repo { font-size:0.75rem; color:var(--muted); border:1px solid var(--line); border-radius:999px; padding:0.05rem 0.55rem; }
  .hit-sig { display:block; font-family:ui-monospace,Menlo,Consolas,monospace; font-size:0.78rem; color:var(--muted); margin-top:0.3rem; overflow:auto; white-space:pre; }
  .hit-desc { margin:0.3rem 0 0; font-size:0.9rem; }
  .empty { color:var(--muted); font-style:italic; }
  h2 { font-size:1rem; margin-top:2rem; }
  ul.repos { list-style:none; padding:0; margin:0; display:grid; gap:0.5rem; }
  ul.repos li { display:flex; gap:0.75rem; align-items:baseline; padding:0.6rem 0.9rem; border:1px solid var(--line); border-radius:10px; background:var(--card); }
  .r-name { font-weight:600; }
  .r-ver, .r-count { color:var(--muted); font-size:0.8rem; }
  footer { text-align:center; color:var(--muted); padding:2rem; font-size:0.85rem; }
</style>
</head>
<body>
<header><div style="font-size:2rem">🔭</div><h1>BrewDocs Federated Search</h1>
<p style="color:var(--muted)">${store.repos.length} repo(s) · ${symbolCount} symbol(s) indexed</p></header>
<main>
  <label for="q" style="position:absolute;left:-9999px">Search all repos</label>
  <input id="q" type="search" placeholder="Search symbols across every repo…" autocomplete="off" />
  <ul id="results"></ul>
  <h2>Indexed repos</h2>
  ${
    store.repos.length
      ? `<ul class="repos">${repoList}</ul>`
      : '<p class="empty">Nothing indexed yet — try <code>brewdocs federate add mylib ./mylib/dist</code></p>'
  }
</main>
<footer>Brewed with <a href="#" style="color:var(--accent)">BrewDocs</a> — Brew your docs, serve them hot.</footer>
<script id="fed-index" type="application/json">${indexJson}</script>
<script>
(function () {
  var data = JSON.parse(document.getElementById("fed-index").textContent);
  var input = document.getElementById("q");
  var results = document.getElementById("results");
  function esc(s) { return String(s == null ? "" : s).replace(/&/g, "&amp;").replace(/</g, "&lt;"); }
  function search(q) {
    q = q.toLowerCase().trim();
    if (!q) { results.innerHTML = ""; return; }
    var terms = q.split(/\\s+/);
    var scored = [];
    for (var r = 0; r < data.length; r++) {
      var repo = data[r];
      for (var i = 0; i < repo.symbols.length; i++) {
        var s = repo.symbols[i];
        var title = s.n.toLowerCase();
        var body = ((s.d || "") + " " + (s.s || "") + " " + repo.repo).toLowerCase();
        var score = 0;
        for (var t = 0; t < terms.length; t++) {
          var term = terms[t];
          if (title.indexOf(term) >= 0) score += 5;
          score += Math.min(body.split(term).length - 1, 10);
        }
        if (score > 0) scored.push({ repo: repo, s: s, score: score });
      }
    }
    scored.sort(function (a, b) { return b.score - a.score; });
    scored = scored.slice(0, 20);
    if (!scored.length) { results.innerHTML = '<li class="empty">No matches across ' + data.length + ' repo(s).</li>'; return; }
    results.innerHTML = scored.map(function (x) {
      var name = x.s.u
        ? '<a class="hit-name" href="' + esc(x.s.u) + '">' + esc(x.s.n) + '</a>'
        : '<span class="hit-name">' + esc(x.s.n) + '</span>';
      return '<li><div class="hit-head">' + name +
        '<span class="hit-repo">' + esc(x.repo.repo) + ' · ' + esc(x.s.k) + '</span></div>' +
        (x.s.s ? '<code class="hit-sig">' + esc(x.s.s) + '</code>' : "") +
        (x.s.d ? '<p class="hit-desc">' + esc(x.s.d) + '</p>' : "") + '</li>';
    }).join("");
  }
  input.addEventListener("input", function () { search(input.value); });
  input.focus();
})();
</script>
</body>
</html>`;
  fs.mkdirSync(outDir, { recursive: true });
  const file = path.join(outDir, "index.html");
  fs.writeFileSync(file, html, "utf8");
  return file;
}
