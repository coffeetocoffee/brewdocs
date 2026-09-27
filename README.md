# ☕ BrewDocs

[![CI](https://github.com/coffeetocoffee/brewdocs/actions/workflows/ci.yml/badge.svg)](https://github.com/coffeetocoffee/brewdocs/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/github/license/coffeetocoffee/brewdocs)](./LICENSE)
[![npm version](https://img.shields.io/npm/v/@brewdocs/cli)](https://www.npmjs.com/package/@brewdocs/cli)

**Brew your docs, serve them hot.** Point it at code, get a beautiful doc site. Zero config, one command, done.

```bash
npx @brewdocs/cli build ./my-project --out dist
# open dist/index.html ☕
```

---

## 🔥 Fresh out of the oven — v4.0

Three things earlier roadmaps kept deferring — none of which added a runtime dependency.

| New | What it gives you |
| --- | --- |
| ⚡ **Render cache** | Extraction was already cached; rendering wasn't. `--cache` now also skips unchanged rendering (`.brewdocs/render.json`), so `--multi` rebuilds stop re-rendering one page per symbol |
| 👀 **Live reload** | `brewdocs preview --watch` rebuilds on change and refreshes the browser over SSE — no dependency, just the server that was already there |
| 🐍 **Static Python by default** | The Python extractor no longer spawns an interpreter: parsing is line-based and safe on any source. The accurate `ast` parser is opt-in with `--plugins python-ast` (it still refuses fetched sources) |
| 📦 **Deploy artifacts** | Every build emits `404.html`, `_headers`, `_redirects` — drop `dist/` on Netlify/Cloudflare Pages and the CDN does the hosting |

---

## 🧱 Previously — v3.9

The containment release. Two remaining findings were the same defect twice: a site-root-relative path from repo config, trusted.

| Fix | Why it mattered |
| --- | --- |
| 📁 **Redirects can no longer write outside the output** | `redirects: {"../x.html": …}` in any repo's `brewdocs.yml` created an HTML file above the build directory. The old guard stopped overwriting, not escaping |
| 🔐 **Theme slot partials are confined** | A `themes/brand.yml` naming `../../id_rsa` used to be read verbatim — and could be embedded in a page you then publish |

Both use one boundary-aware pattern: resolve first, then require the target to equal the root or sit under `root + path.sep`. Both are now invariants (INV-8, INV-9) that `npm run gate` checks, so "fixed" is a tested claim rather than a sentence.

---

## 🗺️ Previously — v3.8

The map release. The repo's knowledge now regenerates itself from the source, so it cannot silently go stale:

| New | What it gives you |
| --- | --- |
| 📄 **[Project Map](./docs/map/PROJECT_MAP.md)** | One screen: shape, trust boundaries (every endpoint × its guard, parsed from the server), where state lives, non-goals, decisions, and every known finding with status |
| 🛡️ **Security gate** | `npm run gate` — the invariants a change must not break, plus one check per fixed finding, so "fixed" is a tested claim. Wired into CI |
| 🤖 **Agent context** | The same facts as JSON, so an AI reloads context without re-reading 16k lines |

```bash
npm run map        # regenerate the map from the source tree
npm run gate       # invariants + finding verification (17 checks)
npm run verify     # typecheck + map + gate + tests — run before a release
```

Numbers in the map are parsed, never typed — CI fails if they drift.

---

## 🔒 Previously — v3.7

The hardening release. BrewDocs renders prose from repos you don't own, and a hosted instance is now safe by default:

| Fix | Why it mattered |
| --- | --- |
| 🔐 **`serve` binds loopback by default** | A bare `brewdocs serve` used to bind every interface with auth *off*, putting the build API on the LAN. `--host 0.0.0.0` is now the explicit opt-in, and a non-loopback bind with no token mints one and prints it |
| 🚫 **No package lifecycle scripts** | Fetching a package ran its `postinstall`; installs now pass `--ignore-scripts` with a trimmed child environment |
| 📁 **Build sources are confined** | `/api/build`, `/api/export`, `/api/markdown` refuse local paths outside `BREWDOCS_SOURCE_ROOT` (403) instead of rendering any readable directory |
| 🧼 **Attribute-safe escaping** | `"` and `'` are escaped, so a hostile README link, symbol description, or **git tag name** can no longer inject attributes (XSS) into a generated site. `javascript:`/`data:` link targets are dropped. Site containment is now boundary-aware — no sibling-prefix or `..` escape |

```bash
brewdocs serve                                 # 127.0.0.1 only — no LAN exposure
brewdocs serve --host 0.0.0.0                  # expose it; you get a token unless one is set
BREWDOCS_SOURCE_ROOT=./repos brewdocs serve    # where the build API may read from
BREWDOCS_TRUST_PROXY=1 brewdocs serve          # trust X-Forwarded-For (only behind a real proxy)
```

Once a token or API key is configured, the read endpoints (`/api/sites`, `/api/registry`, `/api/search`, `/api/stats`) require it too. A per-user key only performs the operations its `--scope` lists, and `X-Forwarded-For` is ignored for rate limiting unless `BREWDOCS_TRUST_PROXY=1`.

---

## 🌊 Before that — v3.5

The intelligence release. Docs that know when they've gone stale, and search that spans every repo:

| New roast | Taste |
| --- | --- |
| 🌊 **Doc drift detection** | `brewdocs drift` fingerprints code vs. prose per symbol — flags "code changed, docs didn't" after every commit or against any git tag (`--from`), with `--fail-on-drift` for CI gates |
| 🔭 **Cross-repo federated search** | `brewdocs federate add` indexes the `docmodel.json` of any number of repos; `search` ranks hits across all of them, `page` ships a standalone offline search UI, and `serve` answers `GET /api/search?q=…` |

```bash
brewdocs drift ./my-lib --record                  # baseline today's docs
brewdocs drift ./my-lib --fail-on-drift           # CI: fail when docs fell behind
brewdocs drift ./my-lib --from v2.0.0             # or compare against a tag
brewdocs federate add mylib ./mylib/dist --url https://mylib.brewdocs.dev
brewdocs federate search "auth token"             # ranked hits across every repo
brewdocs federate page --out federation-site      # standalone search UI
```

---

## 😋 Quick taste

```bash
npm install -g @brewdocs/cli
brewdocs build ./my-project --out dist
```

No install? No problem:

```bash
npx @brewdocs/cli build ./examples/lib
```

Non-devs: `brewdocs serve`, paste a repo URL, hit **Brew**. ☕✨

## 🫘 What's inside

- **README** → sections + frontmatter, **JSDoc/TSDoc** → params, returns, examples, **`package.json`** → version, license, keywords
- **Classes, generics, `@throws`, `@see`** with Rustdoc-style cross-links
- One self-contained HTML page: real theme, `⌘K` search, version switcher, light/dark toggle
- `docmodel.json` next to every build — your docs as queryable data (MCP-ready 🤖)

## 📖 Full menu

<details>
<summary><b>Brew it</b> — build, export, deploy, serve</summary>

| Command | Does what |
| --- | --- |
| `build <src>` | One `index.html` (`--multi` for per-symbol pages, `--watch` to re-brew, `--cache` to skip, `--playground` for Try-it runners, `--locale <code>` for localized UI) |
| `build-all <src>` | Every version (`--workspaces` for monorepos) |
| `export <src>` | Fully self-contained static site (+ `--markdown`, `--json`) |
| `markdown <src>` | Markdown/MDX reference (`--format md\|mdx`, `--multi`) |
| `docmodel <src>` | Machine-readable API knowledge (`--schema` for the JSON Schema) |
| `deploy <src>` | Ship to `*.brewdocs.dev` (`--storage s3`, `--org`, `--private`, `--draft`) |
| `serve` | Local hosting + web drop-in (`/api/build`, `/api/export`, `/api/sites`) + `--tls-cert/--tls-key` HTTPS |
| `cloud …` | Orgs + members (`cloud org create\|list\|add-member\|remove-member\|delete`), org sites + stats |
| `domains …` | Custom domains (`add --site`, `verify`, `list`, `remove`) |
| `audit <dir>` | v3.0 a11y + SEO + perf audit of a built site (`--json`, `--min-score`, `--group`) |
| `registry …` | v3.0 plugin registry + marketplace (`publish\|list\|search\|install\|remove\|gallery`) |
| `drift <src>` | v3.5 doc drift detection (`--record`, `--from <ref>`, `--fail-on-drift`, `--json`) |
| `federate …` | v3.5 cross-repo federated search (`add\|list\|remove\|search\|page`) |
| `preview <src>` | Build + serve locally (`--watch` for rebuild + live reload) |
| `gallery` | Example-sites gallery |
| `themes` | List themes (`coffee`, `ink`, `matcha`, `newsprint` — or your manifest) |
| `locales` | List UI locales (`en`, `de`, `es`, `fr`, `ja`, `id`) |

Common flags: `-o/--out`, `-t/--theme`, `--dark`, `-v/--version`, `-n/--name`, `--storage`, `--multi`, `-w/--watch`, `--plugins <a,b>`, `--cache`, `--playground`, `--locale <code>`, `--no-docmodel`.

</details>

<details>
<summary><b>Guard it</b> — coverage, diffs, CI gates</summary>

- `doctor` — docs coverage score + badge + `--min-coverage` gate + `--record` trends
- `diff --from v1 --to v2` — **semantic** API diff (alias-aware, member shapes included)
- `changelog` — "what broke / migration notes" from a diff
- `ci --base origin/main` — PR report, `--post` to comment, `--fail-on-breaking`
- `gate --from v1` — block breaking releases without a guide or acknowledgment
- `audit <dir>` — v3.0 a11y + SEO + perf checks, `--min-score` to gate CI
- `drift <src>` — v3.5 code-vs-docs drift, `--fail-on-drift` to gate CI

</details>

<details>
<summary><b>Grow it</b> — drafts, proofs, harvests, agents</summary>

- `draft [--fix]` — scaffold JSDoc for undocumented symbols
- `prove [--strict]` — typecheck every `@example` (yes, really)
- `harvest` — propose examples from README + tests
- `mcp [docmodel.json]` — MCP stdio server: `search_symbols`, `symbol_signature`, `deprecated_replacements` (freshness-checked, so agents never sip stale docs)
- `drafts` / `keys` — private draft links + API keys

</details>

## 🎨 Make it yours

```yaml
# brewdocs.yml — CLI flags always win
theme: ink
dark: false
plugins:
  - ./plugin.cjs
cache: true
playground: true
contentDir: content
locale: id          # v3.0 UI locale (en, de, es, fr, ja, id)
registry: ./plugins-registry   # v3.0 local plugin marketplace dir
aliases:            # v3.0 stable URLs for build-all
  latest: 2.5.0
  stable: 2.4.1
eol:                # v3.0 end-of-life versions (banner + switcher mark)
  - 1.x
redirects:          # v3.0 moved pages keep answering
  old/api.html: index.html
```

```yaml
# themes/brand.yml — extend a base, add your flavor
base: ink
vars:
  --accent: "#ff0000"
slots:
  footer: partials/brand-footer.html
```

```yaml
# nav.yml — sidebar for your guides
Guides:
  Getting started: content/getting-started.html
```

```ts
// plugin.cjs — hooks + adapters + theme in one object
module.exports = {
  name: "my-plugin",
  onExtract: (result) => result,
  onRender: (html) => html,
  theme: { vars: { "--accent": "#123456" } },
};
```

## 🤖 Docs as data

Every build emits `docmodel.json` (schema: `brewdocs/docmodel@1`) — symbols, types, coverage, freshness stamp. Bots, CI, and editors welcome:

```bash
brewdocs mcp dist/docmodel.json   # agents, come get your docs
```

## 🚀 Ship it

```yaml
# .github/workflows/brewdocs.yml
- run: npx @brewdocs/cli build ./docs --out docs-site --theme ink
- uses: actions/upload-pages-artifact@v3
  with: { path: docs-site }
```

S3/R2 deploys, private token-gated sites, draft links with expiry, rate-limited hosting — it all works, details in the code and `brewdocs <cmd> --help`.

## 🧱 Under the lid

Monorepo: `@brewdocs/core` (pipeline) + `@brewdocs/cli` (commands + server) + `@brewdocs/plugin-sdk` (contracts). Zero runtime deps besides `typescript`.

```
Source → ExtractResult → RenderModel → standalone HTML
```

```bash
npm install
npm run verify    # typecheck + project-map check + security gate + tests
npm test          # tests only
npm run brewdocs -- build ./docs --theme ink --out docs-site
```

Working on the code? Start with [`docs/map/PROJECT_MAP.md`](./docs/map/PROJECT_MAP.md) — one screen covering the shape, the trust boundaries, where state lives, what this deliberately doesn't do, and every known weakness with its status. It is generated from the source, so its numbers can't drift.

Launch blurbs live in [`PITCH.md`](./PITCH.md). License: MIT. Go brew something. ☕
