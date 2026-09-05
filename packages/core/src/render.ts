import type { PackageInfo, RenderModel, SymbolDoc } from "./types.js";
import { markdownToHtml } from "./markdown.js";
import { highlightCode } from "./highlight.js";
import { getTheme, type Theme } from "./themes.js";
import { buildSearchIndex } from "./search.js";

export interface VersionLink {
  version: string;
  path: string;
  /** Optional link to an API diff page covering this version vs the previous one. */
  diffPath?: string;
}

export interface RenderOptions {
  theme?: string;
  dark?: boolean;
  versions?: VersionLink[];
  currentVersion?: string;
  multiPage?: boolean;
  /** Docs coverage score (0–100) from `brewdocs doctor`; renders an in-page chip. */
  score?: number;
  /** Freshness stamp (Direction C): renders "brewed rev abc1234 · 2026-09-05" in the footer. */
  freshness?: { gitSha?: string; generatedAt?: string };
}

function escapeHtml(input: string): string {
  return input
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function slug(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/**
 * Per-version search-index cache. Building the index is O(symbols) and the
 * latest version's model is rendered twice (its own page + the root index),
 * so memoizing by model identity avoids rebuilding it. ROADMAP Phase 3 open
 * item: "cache index per version to avoid rebuilds".
 */
const searchIndexCache = new WeakMap<RenderModel, string>();
function searchIndexJson(model: RenderModel, multiPage: boolean): string {
  const cached = searchIndexCache.get(model);
  if (cached) return cached;
  const json = JSON.stringify(buildSearchIndex(model, multiPage)).replace(
    /</g,
    "\\u003c",
  );
  searchIndexCache.set(model, json);
  return json;
}

/** Exported symbol name -> link target on the current page layout. */
type SymbolLinks = Map<string, string>;

function symbolLinks(
  model: RenderModel,
  hrefFor: (name: string) => string,
  exclude?: string,
): SymbolLinks {
  const map: SymbolLinks = new Map();
  for (const s of model.symbols) {
    if (s.name !== exclude) map.set(s.name, hrefFor(s.name));
  }
  return map;
}

const IDENT_RE = /[A-Za-z_$][A-Za-z0-9_$]*/g;

/** Escape plain type text and wrap identifiers that name exported symbols in links (Direction A cross-links). */
function linkifyType(text: string, links?: SymbolLinks): string {
  if (!links || links.size === 0 || !text) return escapeHtml(text);
  let out = "";
  let last = 0;
  for (const m of text.matchAll(IDENT_RE)) {
    out += escapeHtml(text.slice(last, m.index));
    const href = links.get(m[0]);
    out += href
      ? `<a class="type-ref" href="${escapeHtml(href)}">${escapeHtml(m[0])}</a>`
      : escapeHtml(m[0]);
    last = m.index + m[0].length;
  }
  out += escapeHtml(text.slice(last));
  return out;
}

/**
 * Cross-link identifiers inside already-highlighted signature HTML. The
 * highlighter emits flat spans, so identifiers of known symbols sit in plain
 * text between tags — linkify those, but never inside comments or strings.
 */
function linkifyHighlighted(code: string, links?: SymbolLinks): string {
  if (!links || links.size === 0 || !code) return code;
  const parts = code.split(/(<[^>]+>)/);
  let out = "";
  let skip = 0;
  for (const part of parts) {
    if (part.startsWith("<")) {
      if (/^<span class="tok-(comment|string)\b/.test(part)) skip++;
      else if (part === "</span>" && skip > 0) skip--;
      out += part;
      continue;
    }
    if (skip > 0) {
      out += part;
      continue;
    }
    out += part.replace(IDENT_RE, (word) => {
      const href = links.get(word);
      return href
        ? `<a class="type-ref" href="${escapeHtml(href)}">${escapeHtml(word)}</a>`
        : word;
    });
  }
  return out;
}

function themeVars(theme: Theme): string {
  const light = Object.entries(theme.light)
    .map(([k, v]) => `  ${k}: ${v};`)
    .join("\n");
  const dark = Object.entries(theme.dark)
    .map(([k, v]) => `  ${k}: ${v};`)
    .join("\n");
  return `:root, [data-theme="light"] {\n${light}\n}\n[data-theme="dark"] {\n${dark}\n}`;
}

function metaTable(pkg: PackageInfo | undefined): string {
  if (!pkg) return "";
  const rows: string[] = [];
  if (pkg.version) rows.push(row("version", pkg.version));
  if (pkg.license) rows.push(row("license", pkg.license));
  if (pkg.homepage) rows.push(row("homepage", pkg.homepage));
  if (pkg.repository) rows.push(row("repository", pkg.repository));
  if (pkg.keywords?.length) rows.push(row("keywords", pkg.keywords.join(", ")));
  return rows.length
    ? `<table class="pkg-meta">\n${rows.join("\n")}\n</table>`
    : "";
}

function row(k: string, v: string): string {
  return `<tr><th>${escapeHtml(k)}</th><td>${escapeHtml(v)}</td></tr>`;
}

function renderSymbol(
  sym: SymbolDoc,
  links?: SymbolLinks,
): string {
  const badge = sym.deprecated
    ? `<span class="badge dep">deprecated</span>`
    : "";
  const typeParams = sym.typeParams?.length
    ? `<span class="kind">&lt;${sym.typeParams
        .map((tp) =>
          tp.constraint
            ? `${escapeHtml(tp.name)} extends ${linkifyType(tp.constraint, links)}${
                tp.default ? ` = ${linkifyType(tp.default, links)}` : ""
              }`
            : escapeHtml(tp.name),
        )
        .join(", ")}&gt;</span>`
    : "";
  const sig = sym.signature
    ? `<pre class="code sig" data-lang="ts"><code>${linkifyHighlighted(
        highlightCode(sym.signature, "ts"),
        links,
      )}</code></pre>`
    : "";
  const desc = sym.description ? `<p>${escapeHtml(sym.description)}</p>` : "";

  const params = sym.params.length
    ? `<div class="params"><h4>Parameters</h4><table>
        ${sym.params
          .map(
            (p) =>
              `<tr><th>${escapeHtml(p.name)}${
                p.optional ? "?" : ""
              }</th><td>${
                p.type ? `<code>${linkifyType(p.type, links)}</code> ` : ""
              }${p.description ? escapeHtml(p.description) : ""}</td></tr>`,
          )
          .join("\n")}
      </table></div>`
    : "";

  const ret = sym.returns
    ? `<div class="returns"><h4>Returns</h4><p>${
        sym.returns.type
          ? `<code>${linkifyType(sym.returns.type, links)}</code> `
          : ""
      }${sym.returns.description ? escapeHtml(sym.returns.description) : ""}</p></div>`
    : "";

  const members = sym.members?.length
    ? `<div class="members"><h4>Members</h4><table>
        ${sym.members
          .map(
            (m) =>
              `<tr><th>${escapeHtml(m.name)}${
                m.optional ? "?" : ""
              } <span class="kind">${escapeHtml(m.kind)}</span></th><td>${
                m.signature
                  ? `<code class="member-sig">${linkifyHighlighted(
                      highlightCode(m.signature, "ts"),
                      links,
                    )}</code>`
                  : m.type
                    ? `<code>${linkifyType(m.type, links)}</code>`
                    : ""
              }${m.description ? ` ${escapeHtml(m.description)}` : ""}</td></tr>`,
          )
          .join("\n")}
      </table></div>`
    : "";

  const throws = sym.throws?.length
    ? `<div class="throws"><h4>Throws</h4><ul>${sym.throws
        .map((t) => `<li>${linkifyType(t, links)}</li>`)
        .join("")}</ul></div>`
    : "";

  const see = sym.see?.length
    ? `<div class="see"><h4>See</h4><ul>${sym.see
        .map((s) => `<li>${linkifyType(s, links)}</li>`)
        .join("")}</ul></div>`
    : "";

  const examples = sym.examples.length
    ? `<div class="examples"><h4>Example</h4>${sym.examples
        .map(
          (e) =>
            `<pre class="code" data-lang="ts"><code>${highlightCode(
              e,
              "ts",
            )}</code></pre>`,
        )
        .join("\n")}</div>`
    : "";

  const file = sym.sourceFile
    ? `<div class="src">${escapeHtml(sym.sourceFile)}</div>`
    : "";

  return `<section class="symbol" id="symbol-${slug(sym.name)}">
    <h3>${escapeHtml(sym.name)} ${typeParams}<span class="kind">${sym.kind}</span> ${badge}</h3>
    ${sig}${desc}${params}${ret}${members}${throws}${see}${examples}${file}
  </section>`;
}

const STRUCTURAL_CSS = `
  * { box-sizing: border-box; }
  html { color-scheme: light dark; }
  body {
    margin: 0; background: var(--bg); color: var(--ink);
    font: 16px/1.65 var(--font);
    transition: background .25s ease, color .25s ease;
  }
  .layout { display: grid; grid-template-columns: 250px 1fr; gap: 2.5rem; max-width: 1140px; margin: 0 auto; }
  header {
    padding: 2.75rem 1.5rem 1.5rem; border-bottom: 1px solid var(--line);
    background: linear-gradient(180deg, var(--card), var(--bg));
  }
  header .cup { font-size: 1.7rem; }
  header h1 { margin: 0.25rem 0 0; font-size: 2.1rem; font-family: var(--heading-font); letter-spacing: -0.01em; }
  .lede { color: var(--muted); margin: 0.5rem 0 0; max-width: 60ch; }
  .coverage-chip {
    display: inline-block; margin-top: 0.6rem; padding: 0.2rem 0.6rem; border-radius: 999px;
    font: 0.78rem var(--font); background: color-mix(in srgb, var(--accent) 16%, var(--card));
    color: var(--accent); border: 1px solid color-mix(in srgb, var(--accent) 35%, transparent);
  }
  .theme-toggle {
    position: absolute; top: 1.25rem; right: 1.5rem; cursor: pointer;
    background: var(--card); color: var(--ink); border: 1px solid var(--line);
    border-radius: 999px; padding: 0.35rem 0.8rem; font: inherit; font-size: 0.85rem;
  }
  .theme-toggle:hover { border-color: var(--accent); color: var(--accent); }
  .header-actions { display: flex; gap: 0.5rem; align-items: center; justify-content: flex-end; position: absolute; top: 1.25rem; right: 1.5rem; }
  .search-toggle { cursor: pointer; background: var(--card); color: var(--ink); border: 1px solid var(--line); border-radius: 999px; padding: 0.35rem 0.8rem; font: inherit; font-size: 0.85rem; }
  .search-toggle:hover { border-color: var(--accent); color: var(--accent); }
  .search-toggle kbd { font-size: 0.7rem; opacity: 0.7; border: 1px solid var(--line); border-radius: 4px; padding: 0 0.25rem; }
  .version { font-size: 0.85rem; color: var(--muted); }
  .version select { font: inherit; font-size: 0.85rem; background: var(--card); color: var(--ink); border: 1px solid var(--line); border-radius: 6px; padding: 0.2rem 0.4rem; }
  .search-overlay { position: fixed; inset: 0; background: rgba(0,0,0,0.45); display: flex; align-items: flex-start; justify-content: center; padding-top: 12vh; z-index: 50; }
  .search-overlay[hidden] { display: none; }
  .search-box { width: min(560px, 92vw); background: var(--card); border: 1px solid var(--line); border-radius: 14px; box-shadow: 0 20px 60px rgba(0,0,0,0.3); overflow: hidden; }
  #search-input { width: 100%; border: none; border-bottom: 1px solid var(--line); padding: 1rem 1.1rem; font: inherit; font-size: 1.05rem; background: transparent; color: var(--ink); outline: none; }
  #search-results { list-style: none; margin: 0; padding: 0.4rem; max-height: 50vh; overflow: auto; }
  #search-results li a { display: flex; justify-content: space-between; gap: 1rem; padding: 0.55rem 0.8rem; border-radius: 8px; text-decoration: none; color: var(--ink); }
  #search-results li a:hover { background: var(--bg); }
  #search-results .r-kind { color: var(--muted); font-size: 0.75rem; text-transform: uppercase; letter-spacing: 0.04em; }
  #search-results .empty { color: var(--muted); padding: 0.8rem; }
  @media (max-width: 820px) { .header-actions { position: static; justify-content: flex-start; margin-bottom: 0.5rem; } }
  nav.toc { position: sticky; top: 1rem; align-self: start; padding: 2rem 0; font-size: 0.92rem; max-height: calc(100vh - 2rem); overflow: auto; }
  nav.toc ul { list-style: none; padding: 0; margin: 0; border-left: 2px solid var(--line); }
  nav.toc li a { color: var(--muted); text-decoration: none; display: block; padding: 0.25rem 0.9rem; }
  nav.toc li a:hover { color: var(--accent); }
  main { padding: 2rem 1.5rem 4rem; min-width: 0; }
  .pkg-meta { width: 100%; border-collapse: collapse; margin: 1.5rem 0; }
  .pkg-meta th, .pkg-meta td { text-align: left; padding: 0.45rem 0.6rem; border-bottom: 1px solid var(--line); vertical-align: top; }
  .pkg-meta th { color: var(--muted); font-weight: 600; width: 28%; }
  .code { background: var(--code-bg); color: var(--code-ink); padding: 1rem 1.1rem; border-radius: 10px; overflow: auto; font-size: 0.88rem; line-height: 1.5; position: relative; }
  .code[data-lang]:not([data-lang=""])::before {
    content: attr(data-lang); position: absolute; top: 0.4rem; right: 0.7rem;
    font-size: 0.7rem; color: var(--muted); text-transform: uppercase; letter-spacing: 0.05em;
  }
  .code.sig { margin: 0.5rem 0 0; }
  code { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }
  :not(pre) > code { background: color-mix(in srgb, var(--accent) 14%, transparent); padding: 0.1rem 0.35rem; border-radius: 4px; }
  a.type-ref { color: var(--accent); text-decoration: none; border-bottom: 1px dotted color-mix(in srgb, var(--accent) 55%, transparent); }
  a.type-ref:hover { border-bottom-style: solid; }
  .code a.type-ref { color: inherit; font: inherit; border-bottom: 1px dotted color-mix(in srgb, var(--accent) 55%, transparent); }
  .tok-comment { color: var(--tok-comment); font-style: italic; }
  .tok-string { color: var(--tok-string); }
  .tok-keyword { color: var(--tok-keyword); font-weight: 600; }
  .tok-number { color: var(--tok-number); }
  .tok-fn { color: var(--tok-fn); }
  h2 { margin-top: 2.25rem; border-bottom: 1px solid var(--line); padding-bottom: 0.35rem; font-family: var(--heading-font); }
  h3 { font-family: var(--heading-font); }
  blockquote { margin: 1rem 0; padding: 0.5rem 1rem; border-left: 3px solid var(--accent); color: var(--muted); background: var(--card); border-radius: 0 8px 8px 0; }
  table:not(.pkg-meta) { width: 100%; border-collapse: collapse; margin: 1rem 0; }
  table:not(.pkg-meta) th, table:not(.pkg-meta) td { border: 1px solid var(--line); padding: 0.45rem 0.6rem; text-align: left; }
  hr { border: none; border-top: 1px solid var(--line); margin: 2rem 0; }
  .symbol { border: 1px solid var(--line); background: var(--card); border-radius: 12px; padding: 1.1rem 1.3rem; margin: 1rem 0; scroll-margin-top: 1rem; }
  .symbol h3 { margin: 0 0 0.5rem; }
  .kind { font-size: 0.72rem; color: var(--muted); font-weight: 400; font-family: var(--font); }
  .badge.dep { background: color-mix(in srgb, var(--accent) 18%, transparent); color: var(--accent); padding: 0.05rem 0.45rem; border-radius: 999px; font-size: 0.7rem; }
  .params th, .params td { text-align: left; padding: 0.3rem 0.5rem; border-bottom: 1px solid var(--line); vertical-align: top; }
  .params th { color: var(--muted); width: 30%; }
  .members th, .members td { text-align: left; padding: 0.35rem 0.5rem; border-bottom: 1px solid var(--line); vertical-align: top; }
  .members th { color: var(--accent); font-weight: 600; white-space: nowrap; width: 32%; }
  .member-sig { font-size: 0.82rem; }
  .throws ul, .see ul { margin: 0.25rem 0 0; padding-left: 1.2rem; }
  .throws li, .see li { margin: 0.15rem 0; }
  .examples h4, .params h4, .returns h4 { margin: 0.9rem 0 0.3rem; font-size: 0.8rem; text-transform: uppercase; letter-spacing: 0.05em; color: var(--muted); }
  .src { color: var(--muted); font-size: 0.8rem; margin-top: 0.5rem; }
  .symbol-index { list-style: none; padding: 0; margin: 1rem 0; }
  .symbol-index li { padding: 0.45rem 0; border-bottom: 1px solid var(--line); }
  .symbol-index a { color: var(--accent); text-decoration: none; font-weight: 600; }
  .symbol-page .back { margin-bottom: 1rem; }
  .symbol-page .back a { color: var(--muted); text-decoration: none; }
  footer { text-align: center; color: var(--muted); padding: 2rem; font-size: 0.85rem; border-top: 1px solid var(--line); }
  .empty-state { padding: 2rem; text-align: center; color: var(--muted); border: 1px dashed var(--line); border-radius: 12px; }
  footer a { color: var(--accent); }
  @media (max-width: 820px) { .layout { grid-template-columns: 1fr; } nav.toc { display: none; } header { position: relative; } }
  :focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; border-radius: 4px; }
  html { scroll-behavior: smooth; }
  main p, main li { text-wrap: pretty; }
  main h2, main h3, main h4 { text-wrap: balance; scroll-margin-top: 1rem; }
  .skip-link {
    position: absolute; left: -999px; top: 0; background: var(--accent); color: #fff;
    padding: 0.5rem 0.9rem; border-radius: 0 0 8px 0; z-index: 50;
  }
  .skip-link:focus { left: 0; }
  nav.toc { font-size: 0.92rem; }
  nav.toc a { color: var(--muted); text-decoration: none; }
  nav.toc a:hover { color: var(--accent); }
`;

function searchOverlay(): string {
  return `
<div class="search-overlay" id="search-overlay" hidden>
  <div class="search-box" role="dialog" aria-label="Search">
    <input id="search-input" type="text" placeholder="Search docs…  (⌘K / Ctrl+K)" autocomplete="off" aria-label="Search documentation" />
    <ul id="search-results"></ul>
  </div>
</div>`;
}

function versionSwitcher(versions: VersionLink[] | undefined, current: string | undefined): string {
  if (!versions || versions.length <= 1) {
    return current
      ? `<span class="version">v${escapeHtml(current)}</span>`
      : "";
  }
  const opts = versions
    .map(
      (v) =>
        `<option value="${escapeHtml(v.path)}"${
          v.version === current ? " selected" : ""
        }>v${escapeHtml(v.version)}</option>`,
    )
    .join("");
  const diffLink = versions.find((v) => v.diffPath && v.version === current)?.diffPath;
  const diffAnchor = diffLink
    ? ` <a class="version-diff" href="${escapeHtml(diffLink)}" title="API diff against the previous version">diff</a>`
    : "";
  return `<label class="version">Version:
    <select id="version-select">${opts}</select>${diffAnchor}
  </label>`;
}

const SEARCH_JS = `
(function () {
  var data = JSON.parse(document.getElementById("search-index").textContent);
  var overlay = document.getElementById("search-overlay");
  var input = document.getElementById("search-input");
  var results = document.getElementById("search-results");
  var toggle = document.getElementById("search-toggle");

  function esc(s) { return s.replace(/&/g, "&amp;").replace(/</g, "&lt;"); }

  function search(q) {
    q = q.toLowerCase().trim();
    if (!q) { results.innerHTML = ""; return; }
    var terms = q.split(/\\s+/);
    var scored = data.map(function (d) {
      var title = d.title.toLowerCase();
      var body = d.body.toLowerCase();
      var score = 0;
      for (var i = 0; i < terms.length; i++) {
        var t = terms[i];
        if (title.indexOf(t) >= 0) score += 5;
        score += Math.min(body.split(t).length - 1, 10);
      }
      return { d: d, score: score };
    }).filter(function (x) { return x.score > 0; })
      .sort(function (a, b) { return b.score - a.score; })
      .slice(0, 8);
    if (!scored.length) { results.innerHTML = '<li class="empty">No results</li>'; return; }
    results.innerHTML = scored.map(function (x) {
      return '<li><a href="' + x.d.url + '"><span class="r-title">' + esc(x.d.title) +
        '</span><span class="r-kind">' + esc(x.d.kind) + '</span></a></li>';
    }).join("");
  }

  function open() { overlay.hidden = false; input.value = ""; results.innerHTML = ""; input.focus(); }
  function close() { overlay.hidden = true; }

  if (toggle) toggle.addEventListener("click", open);
  input.addEventListener("input", function () { search(input.value); });
  results.addEventListener("click", close);
  document.addEventListener("keydown", function (e) {
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") { e.preventDefault(); open(); }
    else if (e.key === "Escape") { close(); }
  });
  overlay.addEventListener("click", function (e) { if (e.target === overlay) close(); });

  var sel = document.getElementById("version-select");
  if (sel) sel.addEventListener("change", function () { location.href = sel.value; });
})();
`;

/** Footer freshness stamp: rev + build date so stale pages are detectable. */
function freshnessHtml(fresh?: { gitSha?: string; generatedAt?: string }): string {
  if (!fresh) return "";
  const bits: string[] = [];
  if (fresh.gitSha) bits.push(`rev ${escapeHtml(fresh.gitSha.slice(0, 7))}`);
  if (fresh.generatedAt) bits.push(escapeHtml(fresh.generatedAt.slice(0, 10)));
  return bits.length ? ` <span class="freshness">· ${bits.join(" · ")}</span>` : "";
}

/** Shared full-document wrapper used by both single- and multi-page output. */function pageShell(opts: {
  title: string;
  description: string;
  toc: string;
  main: string;
  renderOptions: RenderOptions;
  indexJson: string;
}): string {
  const theme = getTheme(opts.renderOptions.theme);
  const initial = opts.renderOptions.dark ? "dark" : "light";
  const title = escapeHtml(opts.title);
  const desc = opts.description
    ? `<p class="lede">${escapeHtml(opts.description)}</p>`
    : "";
  const coverChip =
    opts.renderOptions.score !== undefined
      ? `<span class="coverage-chip" title="Docs coverage from brewdocs doctor">🩺 ${opts.renderOptions.score}% documented</span>`
      : "";
  return `<!doctype html>
<html lang="en" data-theme="${initial}">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${title} · BrewDocs</title>
<style>
${themeVars(theme)}
${STRUCTURAL_CSS}
</style>
</head>
 <body>
 <a class="skip-link" href="#main-content">Skip to content</a>
 ${searchOverlay()}
 <header>
  <div class="header-actions">
    <button class="search-toggle" id="search-toggle" aria-label="Search docs">🔍 <kbd>⌘K</kbd></button>
    ${versionSwitcher(opts.renderOptions.versions, opts.renderOptions.currentVersion)}
    <button class="theme-toggle" id="theme-toggle" aria-label="Toggle theme">🌓</button>
  </div>
  <div class="cup">☕</div>
   <h1>${title}</h1>
   ${desc}
   ${coverChip}
</header>
 <div class="layout">
   <nav class="toc" aria-label="Table of contents"><ul>${opts.toc}</ul></nav>
   <main id="main-content">
     ${opts.main}
   </main>
 </div>
<footer>Brewed with <a href="#">BrewDocs</a>${freshnessHtml(opts.renderOptions.freshness)} — Brew your docs, serve them hot.</footer>
<script id="search-index" type="application/json">${opts.indexJson}</script>
<script>
(function () {
  var root = document.documentElement;
  var saved = localStorage.getItem("brewdocs-theme");
  if (saved) root.setAttribute("data-theme", saved);
  var btn = document.getElementById("theme-toggle");
  if (btn) btn.addEventListener("click", function () {
    var next = root.getAttribute("data-theme") === "dark" ? "light" : "dark";
    root.setAttribute("data-theme", next);
    localStorage.setItem("brewdocs-theme", next);
  });
})();
${SEARCH_JS}
</script>
</body>
</html>
`;
}

/** Render the model into a complete, standalone, themeable HTML document. */
export function renderToHtml(model: RenderModel, options: RenderOptions = {}): string {
  const indexJson = searchIndexJson(model, Boolean(options.multiPage));
  const desc = model.description ?? "";
  const links = symbolLinks(model, (name) => `#symbol-${slug(name)}`);

  const toc = [
    ...model.sections.map(
      (s) => `<li><a href="#${escapeHtml(s.id)}">${escapeHtml(s.title)}</a></li>`,
    ),
    model.symbols.length ? `<li><a href="#api">API</a></li>` : "",
  ]
    .filter(Boolean)
    .join("\n");

  const readmeBody = model.sections.length
    ? model.sections
        .map(
          (s) =>
            `<section id="${escapeHtml(s.id)}"><h2>${escapeHtml(
              s.title,
            )}</h2>${s.html}</section>`,
        )
        .join("\n")
    : (model.readmeHtml ?? "");

  const api = model.symbols.length
    ? `<section id="api"><h2>API</h2>${model.symbols
        .map((s) => renderSymbol(s, links))
        .join("\n")}</section>`
    : "";

  const emptyState =
    !readmeBody && !api
      ? `<section class="empty-state">
          <h2>Nothing brewed yet</h2>
          <p>This package has no README or exported symbols BrewDocs could find.
          Add a <code>README.md</code> or exported functions to see docs here.</p>
        </section>`
      : "";

  const main = `${metaTable(model.pkg)}${readmeBody}${api}${emptyState}`;

  return pageShell({
    title: model.title,
    description: desc,
    toc,
    main,
    renderOptions: options,
    indexJson,
  });
}

export interface RenderedPage {
  path: string;
  html: string;
}

/**
 * Render the model into multiple pages: one `index.html` (README + API summary
 * with links) plus one `symbols/<slug>.html` per exported symbol. The search
 * index links symbol results to their dedicated pages.
 */
export function renderToHtmlMulti(
  model: RenderModel,
  options: RenderOptions = {},
): RenderedPage[] {
  const indexJson = searchIndexJson(model, true);
  const desc = model.description ?? "";

  const symbolSlug = (name: string) => `symbols/${slug(name)}.html`;
  const links = symbolLinks(model, symbolSlug);

  const readmeBody = model.sections.length
    ? model.sections
        .map(
          (s) =>
            `<section id="${escapeHtml(s.id)}"><h2>${escapeHtml(
              s.title,
            )}</h2>${s.html}</section>`,
        )
        .join("\n")
    : (model.readmeHtml ?? "");

  const apiSummary = model.symbols.length
    ? `<section id="api"><h2>API</h2><ul class="symbol-index">
        ${model.symbols
          .map(
            (s) =>
              `<li><a href="${escapeHtml(symbolSlug(s.name))}">${escapeHtml(
                s.name,
              )}</a> <span class="kind">${escapeHtml(s.kind)}</span>${
                s.description ? ` — ${escapeHtml(s.description)}` : ""
              }</li>`,
          )
          .join("\n")}
      </ul></section>`
    : "";

  const indexToc = [
    ...model.sections.map(
      (s) => `<li><a href="#${escapeHtml(s.id)}">${escapeHtml(s.title)}</a></li>`,
    ),
    model.symbols.length ? `<li><a href="#api">API</a></li>` : "",
  ]
    .filter(Boolean)
    .join("\n");

  const indexMain = `${metaTable(model.pkg)}${readmeBody}${apiSummary}`;

  const pages: RenderedPage[] = [
    {
      path: "index.html",
      html: pageShell({
        title: model.title,
        description: desc,
        toc: indexToc,
        main: indexMain,
        renderOptions: options,
        indexJson,
      }),
    },
  ];

  for (const sym of model.symbols) {
    const symToc = `<li><a href="../index.html#api">API</a></li>
      <li><a href="../index.html">${escapeHtml(model.title)}</a></li>`;
    const symMain = `<section class="symbol-page"><p class="back"><a href="../index.html">← Back to docs</a></p>
      ${renderSymbol(sym, symbolLinks(model, (name) => `${slug(name)}.html`, sym.name))}</section>`;
    pages.push({
      path: symbolSlug(sym.name),
      html: pageShell({
        title: `${sym.name} · ${model.title}`,
        description: sym.description ?? "",
        toc: symToc,
        main: symMain,
        renderOptions: options,
        indexJson,
      }),
    });
  }

  return pages;
}
