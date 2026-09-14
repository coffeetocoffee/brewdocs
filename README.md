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

## 🆕 Fresh out of the oven — v3.0

The ecosystem release. More languages, stable URLs, more languages of *docs*, and a QA gate:

| New roast | Taste |
| --- | --- |
| 🦀☕ **#️⃣💎 Rust/Java/C#/Ruby** | Four new built-in static adapters — doc comments, javadoc, XML docs and YARD tags brew into real symbols, zero toolchains needed |
| 🔗 **Aliases, EOL, redirects** | `brewdocs.yml` `aliases:` publish `/latest/`-style URLs that never drift, `eol:` banners flag unmaintained versions, `redirects:` keep moved pages alive |
| 🌍 **i18n** | `--locale` / `locale: id` localizes the UI chrome (6 bundled locales: en, de, es, fr, ja, id — English fallback) and sets `<html lang>` |
| 🔎 **`brewdocs audit`** | Dependency-free a11y + SEO + perf lighthouse for built sites, with `--min-score` CI gates; every brewed page passes 100% out of the box |
| 🛒 **Plugin registry + marketplace** | `registry publish/list/search/install/remove/gallery` — a local, zero-network marketplace feeding `plugins:` resolution (`brewdocs registry --help`) |

```bash
brewdocs build ./rust-crate                       # Rust/Java/C#/Ruby just work
brewdocs build-all ./lib --out dist               # + aliases/eol/redirects from brewdocs.yml
brewdocs build ./my-docs --locale id
brewdocs audit dist --min-score 90                # a11y + seo + perf gate in CI
brewdocs registry publish ./my-plugin.cjs --name my-plugin --version 0.1.0
```

---

## v2.5 recap

The platform release. APIs, interactivity, and hosting grow up:

| New roast | Taste |
| --- | --- |
| 🌐 **OpenAPI + GraphQL** | `openapi.json`/`.yaml` and `*.graphql` brew into documented operations + types — new built-in adapters, zero deps |
| ▶️ **`--playground`** | Editable "Try it" runners under every example. Evaluated client-side, output stays one self-contained HTML file |
| 🏢 **`brewdocs cloud`** | Orgs + member keys, org-gated private docs, per-path analytics and org rollups (`cloud org\|sites\|stats`) |
| 🔒 **Custom domains + TLS** | `domains add\|verify` with well-known token proof, Host routing, `serve --tls-cert/--tls-key` for HTTPS |

```bash
brewdocs build ./api --out dist --playground
brewdocs cloud org create acme
brewdocs domains add docs.acme.com --site lib
brewdocs serve --tls-cert cert.pem --tls-key key.pem
```

---

## v2.0 recap

The big one. BrewDocs grew up (but still fits in one cup):

| New roast | Taste |
| --- | --- |
| 🐍🐹 **Python + Go support** | Not just TypeScript anymore. `brewdocs build ./python-package` just works — AST docstrings, Go doc comments, the whole pot |
| 🔌 **Plugin SDK** | `definePlugin()` + `defineAdapter()` — teach BrewDocs new languages, hook the pipeline, theme it. [`@brewdocs/plugin-sdk`](./packages/plugin-sdk) |
| 📝 **Guides + MDX** | Drop `.md`/`.mdx` in `content/`, get real guide pages with sidebar nav (`nav.yml`) and `<Callout>`-style components |
| 🎨 **Theme manifests** | `themes/brand.yml` — extend `ink`, override vars, inject slot HTML. Your brand, our layout |
| ⚡ **`--cache`** | Content-hash the source, skip the re-brew. Extraction cached in `.brewdocs/extract.json` |

```bash
brewdocs build ./my-project --out dist --theme brand --cache --plugins ./plugin.cjs
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
| `preview <src>` | Build + serve locally |
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
npm test          # 280 tests, all green
npm run brewdocs -- build ./docs --theme ink --out docs-site
```

Launch blurbs live in [`PITCH.md`](./PITCH.md). License: MIT. Go brew something. ☕
