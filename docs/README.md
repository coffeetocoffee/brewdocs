---
title: BrewDocs
summary: Brew your docs, serve them hot.
---

# BrewDocs

**Brew your docs, serve them hot.** Point BrewDocs at a GitHub repo or npm
package and get a clean, hosted one-page doc site. Devs get an API/CLI; non-devs
get a web drop-in.

## What it does

BrewDocs extracts documentation from your project automatically:

- **README** — parsed into sections, with frontmatter support
- **JSDoc / TSDoc** — pulled from your exported functions, classes, and types
- **Exported symbols** — resolved via the TypeScript compiler (types, params, returns)
- **package.json** — name, version, license, keywords, and more

It then renders a single, self-contained HTML page with a real theme, client-side
search (press `⌘K` / `Ctrl+K`), a version switcher, and a light/dark toggle.

## Install

```bash
npm install -g brewdocs
```

Or run it without installing:

```bash
npx brewdocs build ./my-project
```

## CLI usage

| Command | Description |
| --- | --- |
| `brewdocs build <src>` | Extract docs into a single `index.html` |
| `brewdocs build-all <src>` | Build every discovered version |
| `brewdocs export <src>` | Static export (fully self-contained) |
| `brewdocs deploy <src>` | Deploy to a local `*.brewdocs.dev` subdomain |
| `brewdocs serve` | Start the local hosting server + web drop-in |
| `brewdocs versions <src>` | List available versions |
| `brewdocs themes` | List available themes |

### Options

- `-o, --out <dir>` — output directory (default `dist`)
- `-t, --theme <name>` — `coffee` (default), `ink`, `matcha`, `newsprint`
- `--dark` — force dark mode
- `-v, --version <tag>` — build a specific version (git tag)
- `-n, --name <sub>` — subdomain name for deploy

Example:

```bash
brewdocs build ./examples/lib --theme matcha --out dist
```

## Web drop-in

Not a developer? Run `brewdocs serve` and open the local URL. Paste a GitHub
repo, an npm package, or a local path, hit **Brew**, and get a live preview with
**Open**, **Export HTML**, and **Re-brew** actions.

## Themes

BrewDocs ships themes that don't look like every other doc site. Each theme is
just a set of CSS custom properties, so switching never touches layout:

- **Coffee** — warm, serif headings, the default
- **Ink** — editorial black-on-white serif
- **Matcha** — soft green
- **Newsprint** — minimal off-white serif

## API

The hosted tier exposes a tiny API:

```bash
curl -X POST http://localhost:4000/api/build \
  -H 'content-type: application/json' \
  -d '{"source":"./examples/lib"}'
# => {"url":"https://lib.brewdocs.dev","subdomain":"lib"}
```

- `POST /api/build` — brew from a local path, npm package, or GitHub URL
- `POST /api/export` — download the built HTML
- `GET /api/sites` — list deployed sites

## How it's built

BrewDocs is itself documented with BrewDocs — this page was brewed from its own
README. The pipeline is a monorepo:

- `@brewdocs/core` — extractors, renderer, themes, search, deploy
- `@brewdocs/cli` — the command line + local hosting server

> BrewDocs: brew your docs, serve them hot.
