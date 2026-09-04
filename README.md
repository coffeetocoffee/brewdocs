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
| `brewdocs doctor <src>` | Docs coverage report (+ badge, JSON, CI gate, trend) |
| `brewdocs diff <src>` | API diff between two git tags (migration guide) |
| `brewdocs changelog <src>` | Auto changelog section from an API diff |
| `brewdocs ci <src>` | PR report: coverage delta + API diff vs base (--post to comment) |
| `brewdocs gate <src>` | Release gate: breaking changes need a guide or acknowledgment |
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

## Docs coverage (`brewdocs doctor`)

Score your API documentation and gate CI on it:

```bash
brewdocs doctor ./my-project               # terminal report (score + issues)
brewdocs doctor ./my-project --json        # machine-readable report
brewdocs doctor ./my-project --badge docs-coverage.svg   # codecov-style SVG badge
brewdocs doctor ./my-project --min-coverage 80   # exit 1 below 80%
```

The score weighs documented symbols (60%), documented params (20%),
documented return types (10%), and usage examples (10%). Set a
persistent threshold in `brewdocs.yml` with `minCoverage: 80`.

### Coverage trends

Record the score on every build and watch the trend (one record per
version, capped at 100 entries; commit `.brewdocs/coverage.json` to keep
the trend across CI runs):

```bash
brewdocs doctor ./my-project --record                  # append score to .brewdocs/coverage.json
brewdocs doctor ./my-project                           # shows the trend when history exists
brewdocs doctor ./my-project --trend-svg docs-trend.svg  # sparkline SVG for your README
```

## CI guardian

`brewdocs ci` compares the working tree against a base ref and reports
coverage changes plus the API diff — built for PRs:

```bash
brewdocs ci . --base origin/main                       # print the markdown report
brewdocs ci . --base origin/main --post                # post/update one PR comment (marker-tracked)
brewdocs ci . --base origin/main --post --min-coverage 80 --fail-on-breaking   # gate the PR
```

`--post` needs `GITHUB_TOKEN` and a PR number (`--pr N`, `GITHUB_REF`, or the
pull_request event payload). It finds the existing comment by the
`<!-- brewdocs:ci -->` marker and updates it instead of spamming. With the
bundled GitHub Action, set `pr-comment: true` (and optionally
`min-coverage`) to wire this up; the workflow needs
`permissions: pull-requests: write`.

## Release gate

Block a release that breaks the API unless a migration guide is generated
or the break is explicitly acknowledged:

```bash
brewdocs gate . --from v1.0.0                    # exit 1 when breaking changes are unhandled
brewdocs gate . --from v1.0.0 --out dist         # passes: writes dist/MIGRATION.md + dist/diff.html
brewdocs gate . --from v1.0.0 --acknowledge "reviewed"   # passes: records .brewdocs/*.ack.json
```

## Auto-generated changelog sections

Turn an API diff into a "What's new / What broke / Migration notes"
markdown section (plain text, or inserted after the H1 of an existing
CHANGELOG):

```bash
brewdocs changelog . --from v1.0.0 --to v2.0.0                 # print the section
brewdocs changelog . --from v1.0.0 --to v2.0.0 --out section.md
brewdocs changelog . --from v1.0.0 --to v2.0.0 --file CHANGELOG.md
```

## Migration guides (`brewdocs diff`)

Diff the exported API between two git tags and generate a standalone
"What's new / What broke" page:

```bash
brewdocs diff ./my-project --from v1.0.0 --to v2.0.0 --out dist
# -> dist/diff.html (added / removed / changed, breaking changes highlighted)
brewdocs diff ./my-project --from v1.0.0 --to v2.0.0 --json
```

On multi-version sites (`brewdocs build-all`), diff pages between
consecutive versions are generated automatically and linked from the
version switcher.

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
>
> By default those endpoints are also protected from abuse: a per-IP rate
> limiter (env `BREWDOCS_RATE_LIMIT`, `BREWDOCS_RATE_WINDOW_MS`; defaults 10
> req / 60s) and a bounded build job queue (env `BREWDOCS_MAX_BUILDS`,
> `BREWDOCS_MAX_QUEUE`; defaults 2 concurrent, 8 queued). Excess requests get
> `429` (rate limited) or `503` (queue full) with a `Retry-After` header, so a
> synchronous git-clone + TS-compile per request can't be used to OOM the box.

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
