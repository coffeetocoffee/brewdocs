# BrewDocs — Launch Copy

**Tagline:** Brew your docs, serve them hot.

## One-liner (350 chars, fun + clean)

☕ BrewDocs — brew your docs, serve them hot. Point it at a GitHub repo or npm
package and get a clean, one-page doc site with zero config. It pulls your
README, JSDoc/TSDoc, and exported symbols, then themes it, adds search (⌘K),
versions, and deploys to a subdomain or static HTML. Devs get a CLI/API; everyone
else gets a paste-and-brew web drop-in.

## Hacker News (Show HN)

**Show HN: BrewDocs — point it at a repo or npm package, get a clean doc site**

I kept dodging writing docs sites for small libraries, so I built a tool that
generates one from what you already have: the README, JSDoc/TSDoc comments, and
exported symbols (resolved via the TypeScript compiler). No config, no MDX
pipeline, no theme to maintain — you get a single themed HTML page with
client-side search (⌘K), a version switcher, and a light/dark toggle.

`npx brewdocs build ./my-project` → `index.html`. Or paste a GitHub repo into
the web drop-in and hit Brew. There's also `deploy` to a local
`*.brewdocs.dev` subdomain and an S3/R2 adapter for real hosting.

It's local-first and dependency-light by design. Curious what breaks on *your*
repo — feedback welcome.

## ProductHunt

**BrewDocs — Brew your docs, serve them hot.**

Turn any GitHub repo or npm package into a clean, one-page documentation site in
seconds. BrewDocs extracts your README, JSDoc/TSDoc, and exported symbols, then
renders a themed page with ⌘K search, versions, and dark mode. Devs get a CLI and
API; non-devs get a paste-and-brew web drop-in. Zero config.

## Key features (bullets)

- Zero-config: README + JSDoc/TSDoc + exported symbols → one HTML page
- 4 themes (coffee, ink, matcha, newsprint) + light/dark
- Client-side ⌘K search, no external dependency
- Version switcher (git tags or package version)
- `deploy` to a local `*.brewdocs.dev` subdomain, or S3/R2 for real hosting
- Web drop-in for non-devs (paste a repo, hit Brew)
- `brewdocs.yml` config, `--watch`, and `--multi` (per-symbol pages)
