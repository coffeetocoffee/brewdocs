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

## 🆕 Fresh out of the oven — v2.0

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
| `build <src>` | One `index.html` (`--multi` for per-symbol pages, `--watch` to re-brew, `--cache` to skip) |
| `build-all <src>` | Every version (`--workspaces` for monorepos) |
| `export <src>` | Fully self-contained static site (+ `--markdown`, `--json`) |
| `markdown <src>` | Markdown/MDX reference (`--format md\|mdx`, `--multi`) |
| `docmodel <src>` | Machine-readable API knowledge (`--schema` for the JSON Schema) |
| `deploy <src>` | Ship to `*.brewdocs.dev` (`--storage s3`, `--org`, `--private`, `--draft`) |
| `serve` | Local hosting + web drop-in (`/api/build`, `/api/export`, `/api/sites`) |
| `preview <src>` | Build + serve locally |
| `gallery` | Example-sites gallery |
| `themes` | List themes (`coffee`, `ink`, `matcha`, `newsprint` — or your manifest) |

Common flags: `-o/--out`, `-t/--theme`, `--dark`, `-v/--version`, `-n/--name`, `--storage`, `--multi`, `-w/--watch`, `--plugins <a,b>`, `--cache`, `--no-docmodel`.

</details>

<details>
<summary><b>Guard it</b> — coverage, diffs, CI gates</summary>

- `doctor` — docs coverage score + badge + `--min-coverage` gate + `--record` trends
- `diff --from v1 --to v2` — **semantic** API diff (alias-aware, member shapes included)
- `changelog` — "what broke / migration notes" from a diff
- `ci --base origin/main` — PR report, `--post` to comment, `--fail-on-breaking`
- `gate --from v1` — block breaking releases without a guide or acknowledgment

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
contentDir: content
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
npm test          # 215 tests, all green
npm run brewdocs -- build ./docs --theme ink --out docs-site
```

Launch blurbs live in [`PITCH.md`](./PITCH.md). License: MIT. Go brew something. ☕
