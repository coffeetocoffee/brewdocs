# ☕ BrewDocs

[![CI](https://github.com/coffeetocoffee/brewdocs/actions/workflows/ci.yml/badge.svg)](https://github.com/coffeetocoffee/brewdocs/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/github/license/coffeetocoffee/brewdocs)](./LICENSE)
[![npm version](https://img.shields.io/npm/v/@brewdocs/cli)](https://www.npmjs.com/package/@brewdocs/cli)

**Brew your docs, serve them hot.**

Point BrewDocs at a GitHub repo or npm package and get a clean, hosted, one-page
doc site. Devs get an API/CLI; non-devs get a web drop-in.

BrewDocs automatically extracts documentation from:

- **README** — parsed into sections, with frontmatter support
- **JSDoc / TSDoc** — pulled from your exported functions, classes, and types
- **Exported symbols** — resolved via the TypeScript compiler (types, params, returns)
- **package.json** — name, version, license, keywords, and more

It renders a single, self-contained HTML page with a real theme, client-side
search (`⌘K` / `Ctrl+K`), a version switcher, and a light/dark toggle.

---

## Quick start

```bash
npm install -g @brewdocs/cli
brewdocs build ./my-project --out dist
# open dist/index.html
```

Or without installing:

```bash
npx @brewdocs/cli build ./examples/lib
```

## CLI

| Command | Description |
| --- | --- |
| `brewdocs build <src>` | Extract docs into a single `index.html` |
| `brewdocs build-all <src>` | Build every discovered version |
| `brewdocs export <src>` | Static export (fully self-contained) |
| `brewdocs deploy <src>` | Deploy to a local `*.brewdocs.dev` subdomain |
| `brewdocs serve` | Start the local hosting server + web drop-in |
| `brewdocs versions <src>` | List available versions |
| `brewdocs themes` | List available themes |
| `brewdocs gallery` | Build a gallery of example sites |

### Common options

- `-o, --out <dir>` — output directory (default `dist`)
- `-t, --theme <name>` — `coffee` (default), `ink`, `matcha`, `newsprint`
- `--dark` — force dark mode
- `-v, --version <tag>` — build a specific version (git tag)
- `-n, --name <sub>` — subdomain name for `deploy`
- `--storage <local|s3>` — backend for `deploy` / `serve` (see below)
- `--multi` — emit one HTML page per exported symbol (`symbols/<name>.html`)
- `-w, --watch` — rebuild on source changes (`build` only)

## Web drop-in (for non-devs)

```bash
brewdocs serve
```

Open the printed URL, paste a GitHub repo / npm package / local path, hit **Brew**,
and get a live preview with **Open**, **Export HTML**, and **Re-brew** actions.

## Themes

Each theme is just a set of CSS custom properties, so switching never touches
layout:

- **Coffee** — warm, serif headings (default)
- **Ink** — editorial black-on-white serif
- **Matcha** — soft green
- **Newsprint** — minimal off-white serif

## Configuration (`brewdocs.yml`)

A `brewdocs.yml` (or `brewdocs.json`) in the source directory sets build defaults;
CLI flags always override it:

```yaml
theme: ink
dark: false
name: mydocs
multi: true
storage: s3          # local (default) or s3
s3:
  bucket: my-bucket
  region: auto
  endpoint: https://<acct>.r2.cloudflarestorage.com
```

## Auto-publish your docs (GitHub Action)

Add `.github/workflows/brewdocs.yml` (see the repo's own, which builds `./docs`)
to brew your docs to GitHub Pages on every push:

```yaml
- run: npx @brewdocs/cli build ./docs --out docs-site --theme ink
- uses: actions/upload-pages-artifact@v3
  with: { path: docs-site }
```

Launch copy (Show HN / ProductHunt blurbs) lives in [`PITCH.md`](./PITCH.md).

## Local API

When you run `brewdocs serve`, these endpoints are available:

- `POST /api/build` — `{ "source": "./examples/lib" }` → `{ "url": "https://lib.brewdocs.dev", "subdomain": "lib" }`
- `POST /api/export` — returns the built HTML as a download
- `GET /api/sites` — list deployed sites

`source` may be a local path, an npm package name, or a GitHub URL.

Run `brewdocs serve --storage s3` (with the `BREWDOCS_S3_*` env vars above) to make
the live server deploy new brews straight to object storage instead of the local
`hosting/` folder.

> **Securing the hosted server:** when `BREWDOCS_TOKEN` is set, the `/api/build`
> and `/api/export` endpoints require `Authorization: Bearer <token>`. Set it
> before exposing `brewdocs serve` to the network.

## Deploying to real object storage (S3 / Cloudflare R2)

By default `deploy` writes to a local directory. To deploy to S3-compatible
storage (e.g. Cloudflare R2), install the AWS SDK and set environment variables:

```bash
npm i @aws-sdk/client-s3

export BREWDOCS_S3_BUCKET=my-bucket
export BREWDOCS_S3_REGION=auto
export BREWDOCS_S3_ENDPOINT=https://<account>.r2.cloudflarestorage.com
export BREWDOCS_S3_ACCESS_KEY_ID=...
export BREWDOCS_S3_SECRET_ACCESS_KEY=...
export BREWDOCS_PUBLIC_DOMAIN=brewdocs.dev   # serves <sub>.brewdocs.dev

brewdocs deploy ./examples/lib --name lib --storage s3
```

BrewDocs uploads the whole built site to `<bucket>/<subdomain>/...` and prints
the public URL. Point a wildcard DNS record (`*.<public-domain>`) at your bucket
to serve every subdomain.

> The local backend keeps the project dependency-free; the S3 adapter loads
> `@aws-sdk/client-s3` only when `--storage s3` is selected.

## Architecture

Monorepo (npm workspaces):

- `@brewdocs/core` — extractors, markdown + syntax highlighter, themes, search
  index, versioning, deploy/storage adapters, gallery
- `@brewdocs/cli` — the command line interface + local hosting server + web drop-in

The core pipeline is a pure flow:

```
Source → ExtractResult → RenderModel → standalone HTML
```

## Development

```bash
npm install
npm test          # 40+ tests across extractors, render, search, deploy, API
npm run brewdocs -- build ./docs --theme ink --out docs-site   # dogfood docs
npm run brewdocs -- gallery --out gallery                      # example gallery
```

## License

MIT
