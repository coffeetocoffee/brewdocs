# BrewDocs v3.7.0 — Hardening

BrewDocs renders prose from repositories you don't own, and a hosted instance is
reachable by others. v3.7 draws the trust boundaries that were previously missing:
the server is closed by default, fetching a package can no longer execute code,
the build API can no longer read arbitrary files, and no untrusted string can
escape into an HTML attribute.

All four issues below were reproduced end-to-end against v3.5.0 before being fixed,
and each fix ships with a regression test.

## 🔐 `serve` is safe by default

`server.listen(port)` binds **every** interface on Node, so a bare `brewdocs serve`
was answering the LAN with auth disabled — and the build API can run code on the
host. The banner said `localhost`; the socket said otherwise.

- The bind address is now explicit and defaults to **`127.0.0.1`**.
- Expose it deliberately with `--host 0.0.0.0` (or `BREWDOCS_HOST`).
- A non-loopback bind with no `BREWDOCS_TOKEN` and no configured keys **mints a
  token and prints it** before serving, so the API is never anonymously reachable.
- `brewdocs preview` is likewise pinned to loopback.

```bash
brewdocs serve                # 127.0.0.1 only
brewdocs serve --host 0.0.0.0 # exposed — prints a generated token
```

## 🚫 Package fetches no longer run lifecycle scripts

Resolving an npm name ran `npm install`, which executes the package's `postinstall`
and friends. Combined with an open build endpoint, a caller-supplied package name was
arbitrary code execution.

- Installs now pass **`--ignore-scripts`** — BrewDocs only needs the package's README
  and source to build docs, never its scripts.
- The child process gets a **trimmed environment** (PATH/tmp/proxy/npm config only),
  so unrelated secrets are not inherited into install scripts.

## 📁 The build API is confined to a source root

`/api/build`, `/api/export`, and `/api/markdown` accepted any readable path on the
machine and would render it — `/api/export` returned the HTML directly, so a README
containing a key was disclosed verbatim.

- Local sources must now live under **`BREWDOCS_SOURCE_ROOT`** (default: the server's
  working directory). Anything outside is refused with **403**.
- Symlinks are resolved before the check, so neither `..` nor a symlink escapes.
- npm names and GitHub URLs are unaffected — they are fetched, not read locally.

```bash
BREWDOCS_SOURCE_ROOT=./repos brewdocs serve
```

## 🧼 Attribute-safe escaping (XSS)

`escapeHtml` escaped `& < >` but **not quotes**, while interpolating untrusted values
into attributes (`href`, `value`, `title`). A README link, a symbol description, or a
**git tag name** could therefore inject an event handler into a generated site.

- `"` and `'` are now escaped, making the helper correct for attributes as well as
  text — this closes every interpolation site at once, including the version switcher.
- Link and image **URLs** are validated; `javascript:`, `vbscript:`, and `data:`
  targets (including control-character-smuggled variants) are dropped.
- The same treatment was applied to the federated-search UI.

## 🔒 Hosting containment is boundary-aware

`resolveSite` used `startsWith` for containment, which accepted a sibling whose name
shared the target's prefix (`/s/acme/../acme-secret`), and the `Host` header
`...brewdocs.dev` slugified to `..`, reaching above the hosting directory.

- Containment now resolves first and requires the root itself or root + separator.
- Subdomain labels must be plain DNS-ish values; dots-only and separator-bearing
  labels are refused.

## Also

- README refreshed for v3.7; the stale test count was corrected (323 passing).

## Verification

- `npm run typecheck` clean.
- `npm test` — **323 passed / 4 skipped** across 47 files (12 new regression tests
  covering loopback classification, source confinement, prefix-confusion traversal,
  and markdown/link escaping).
- `brewdocs build ./examples/tiny` smoke build produces `index.html`.

## Upgrading

No API changes. Two behaviour changes to be aware of when hosting:

1. `brewdocs serve` now listens on loopback. Pass `--host 0.0.0.0` to restore the old
   reach (you will get a token unless you set `BREWDOCS_TOKEN` or add keys).
2. Local build sources are confined to `BREWDOCS_SOURCE_ROOT` (default: the working
   directory). Point it at a broader tree if you serve repositories from elsewhere.

**Full diff:** https://github.com/coffeetocoffee/brewdocs/compare/v3.5.0...v3.7.0
