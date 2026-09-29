# ☕ BrewDocs

[![CI](https://github.com/coffeetocoffee/brewdocs/actions/workflows/ci.yml/badge.svg)](https://github.com/coffeetocoffee/brewdocs/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/github/license/coffeetocoffee/brewdocs)](./LICENSE)
[![npm version](https://img.shields.io/npm/v/@brewdocs/cli)](https://www.npmjs.com/package/@brewdocs/cli)
[![npm downloads](https://img.shields.io/npm/dm/@brewdocs/cli)](https://www.npmjs.com/package/@brewdocs/cli)

**Brew your docs, serve them hot.** Point it at code, get a beautiful doc site. Zero config, one command, done.

```bash
npx @brewdocs/cli build ./my-project --out dist
# open dist/index.html ☕
```

---

## 🔥 Fresh out of the oven — v4.4

Two trust-and-hygiene features, still zero runtime dependencies.

| New | What it gives you |
| --- | --- |
| 🔏 **Registry integrity** | `registry publish` records a `sha256` of the stored module; `brewdocs registry verify` re-checks every entry, and `install`/load refuse a tampered one. Tamper-evident without a server |
| 🔧 **Config migration** | `brewdocs.yml`/`.json` carry a `configVersion`; `brewdocs migrate [--write]` stamps it (comments preserved), and a config newer than the tool warns instead of being silently misread |

Earlier this line: **v4.3** single-source escaping + all-files security scan · **v4.2** config validation (unknown keys/parse errors warn, never crash) · **v4.1** render cache, live reload, static Python default, deploy artifacts · **v4.0** TypeScript depth (enums, namespaces, decorators, subpath exports).

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
| `registry …` | v3.0 plugin registry + marketplace (`publish\|list\|search\|install\|remove\|verify\|gallery`) — `verify` re-checks each entry's recorded `sha256` |
| `drift <src>` | v3.5 doc drift detection (`--record`, `--from <ref>`, `--fail-on-drift`, `--json`) |
| `federate …` | v3.5 cross-repo federated search (`add\|list\|remove\|search\|page`) |
| `preview <src>` | Build + serve locally (`--watch` for rebuild + live reload) |
| `migrate [src]` | v4.4 stamp `configVersion` on a `brewdocs.yml`/`.json` (`--write` to apply, `--json`) |
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
