# Project Map — brewdocs

> **Generated file. Do not edit.** Run `npm run map` to regenerate;
> CI (`npm run map:check`) fails if this is out of date.
>
> Facts a machine cannot infer live in [`facts/`](./facts) and are reviewed by humans.
> Everything below with a number in it is parsed from the source tree.

_Generated: 2026-09-26_

## What this is

A zero-config documentation generator for code. Point it at a local path, an npm package name, or a GitHub URL and it produces one self-contained HTML page (plus a queryable `docmodel.json`). It also ships a hosting server, a CLI with coverage/diff/gate tooling, language adapters beyond JS/TS, and an MCP server so agents can read the same model.

The product's whole job is rendering prose from repositories **you do not own** — READMEs, doc comments, git tag names. That is the threat model everything in `facts/invariants.json` follows from.

## Shape

| Package | Version | Role | Source | Tests |
| --- | --- | --- | --- | --- |
| `@brewdocs/cli` | 3.8.0 | commands + hosting server | 4 files / 2,989 loc | 8 files / 1,116 loc |
| `@brewdocs/core` | 3.8.0 | pipeline: extract → model → render | 55 files / 12,907 loc | 38 files / 4,693 loc |
| `@brewdocs/plugin-sdk` | 3.8.0 | adapter/hook contracts | 1 files / 57 loc | 1 files / 351 loc |

**321 test declarations across 47 files** — parsed from the tree, not typed.

> 13 file(s) declare tests inside a fixture loop, so a `vitest` run reports more cases than the declaration count above: `audit.test.ts`, `ci.test.ts`, `draft.test.ts`, `drift.test.ts`, `federation.test.ts`, `fuzz.test.ts`, `harvest.test.ts`, `languages.test.ts`, `openapi.test.ts`, `prove.test.ts`, `realworld.test.ts`, `robust.test.ts`, `workspaces.test.ts`. That is expected — the declaration count is the stable number.

## Trust boundaries

Every entry point that accepts caller-controlled input, and the exact guard on it. This is derived from `packages/cli/src/server.ts` on every run.

| Endpoint | Method | Guards | Defined at |
| --- | --- | --- | --- |
| `/api/build` | POST | `authenticate` | `packages/cli/src/server.ts:527` |
| `/api/export` | POST | `authenticate` | `packages/cli/src/server.ts:596` |
| `/api/sites` | GET | **none** | `packages/cli/src/server.ts:661` |
| `/api/registry` | GET | **none** | `packages/cli/src/server.ts:669` |
| `/api/search` | GET | **none** | `packages/cli/src/server.ts:686` |
| `/api/markdown` | POST | `authenticate` | `packages/cli/src/server.ts:700` |
| `/api/stats` | GET | `requireAuth` | `packages/cli/src/server.ts:745` |
| `/` | GET | **none** | `packages/cli/src/server.ts:793` |
| `/dashboard` | GET | **none** | `packages/cli/src/server.ts:809` |

### Invariants a change must not break

- **INV-1** — The hosting server binds 127.0.0.1 unless the operator passes --host. A non-loopback bind with no token and no keys mints a token before serving.
  - _why:_ `server.listen(port)` binds every interface on Node. The build API can run npm install, so an open instance on a LAN is remote code execution, and the startup banner used to say 'localhost' while the socket said otherwise.
  - _enforced by:_ packages/cli/src/server.test.ts (source confinement), packages/cli/src/cli-commands.test.ts (isLoopbackHost)
- **INV-2** — Fetching an npm package must pass --ignore-scripts and must not pass the parent process environment through to the child.
  - _why:_ BrewDocs only needs a package's README and source to build docs. Lifecycle scripts (postinstall et al.) are arbitrary code execution from a caller-supplied name, reachable from the build API.
  - _enforced by:_ packages/core/src/resolve.test.ts
- **INV-3** — Every endpoint that reads a caller-supplied local path must resolve it against sourceRoot and refuse anything outside with 403. Realpath first, so neither .. nor a symlink escapes.
  - _why:_ A build endpoint that renders any readable directory is a file-disclosure primitive; /api/export returned the HTML directly, so a README containing a key was disclosed verbatim.
  - _enforced by:_ packages/cli/src/server.test.ts (Phase 5 — source confinement)
- **INV-4** — Any HTML escape helper must escape " and ' as well as & < >, because untrusted values are interpolated into quoted attributes (href, value, title).
  - _why:_ This is the contract, not one call site: the helper is named escapeHtml and is used for both text nodes and attributes. Escaping only &<> let a README link, a symbol description, or a git tag name inject an event handler into a generated site.
  - _enforced by:_ packages/core/src/markdown.test.ts
- **INV-5** — Path containment must be boundary-aware: resolve the candidate and require it to equal the root or start with root + path.sep. Never use a bare startsWith.
  - _why:_ startsWith accepted a sibling whose name shared the target's prefix (/s/acme/../acme-secret resolved outside hosting/acme). The existing traversal test passed for the wrong reason — Node's URL normalizer, not the code.
  - _enforced by:_ packages/cli/src/server.test.ts (prefix-confusion, dots-only subdomains)
- **INV-6** — A site subdomain must be a plain DNS-ish slug; dots-only and separator-bearing values are refused before any path resolution.
  - _why:_ The Host header is caller-controlled and `...brewdocs.dev` slugifies to `..`, which reaches above the hosting directory.
  - _enforced by:_ packages/cli/src/server.test.ts (rejects dots-only / separator-bearing subdomains)
- **INV-7** — A URL placed in href/src must have its scheme validated; javascript:, vbscript: and data: are dropped, including control-character-smuggled forms.
  - _why:_ Markdown link targets come from third-party prose. `java\nscript:` is still javascript: to a browser, so the scheme check must strip control characters before sniffing.
  - _enforced by:_ packages/core/src/markdown.test.ts

### Server defaults

- bind address default: `127.0.0.1` (explicit `listen(port, host)`)
- network bind without configured auth auto-generates a token: yes

## Where state lives

| Store | File | Written by |
| --- | --- | --- |
| Per-site deploy manifest (visibility, tokenHash, draft expiry, title) | `hosting/<subdomain>/.brewdocs.json` | deploySite() in core/src/deploy.ts |
| Per-user API keys (sha256 only; raw key shown once) | `hosting/.keys.json` | cli/src/keys.ts — `brewdocs keys add` |
| Orgs, members, org-owned sites | `hosting/.cloud.json` | core/src/cloud.ts — `brewdocs cloud` |
| Custom domain → subdomain mapping + verification token | `hosting/.domains.json` | core/src/domains.ts — `brewdocs domains` |
| Plugin registry entries (local marketplace) | `<registryDir>/.registry.json` | core/src/registry.ts — `brewdocs registry` |
| Federated search index (per-repo symbols from docmodel.json) | `<storeDir>/.federation.json` | core/src/federation.ts — `brewdocs federate` |
| Pageview/build counters and top paths | `hosting/.analytics.json` | cli/src/server.ts StatsStore |
| Drift baseline (code vs docs fingerprints per symbol) | `<src>/.brewdocs/drift.json` | core/src/drift.ts — `brewdocs drift --record` |
| Coverage trend history | `<src>/.brewdocs/coverage.json` | core/src/doctor.ts — `brewdocs doctor --record` |
| Extraction cache (content-hash keyed) | `<src>/.brewdocs/extract.json` | core/src/cache.ts |
| Machine-readable API artifact emitted by every build | `<out>/docmodel.json` | core/src/docmodel.ts (schema brewdocs/docmodel@1) |

## Boundaries and non-goals

- **No backend service.** Deployment, orgs, domains, TLS issuance, analytics and the plugin marketplace are local emulations backed by JSON files beside the hosting dir. `brewdocs deploy` writes to a local directory unless `--storage s3` is given.
- **No real ACME.** TLS is serve-side: the operator supplies a certificate. `createSecureServer` wires it into the same request pipeline.
- **No remote cache.** The incremental cache is local extraction-only; rendering always runs.
- **No browser in CI.** `brewdocs audit` is static over emitted HTML by explicit design — contrast ratios, real render cost and JS execution are out of scope.
- **No AST parsers for non-JS languages.** Adapters are heuristics (D-3). Go is a regex parser; Python shells out to an embedded AST helper and degrades with a warning when `python` is absent.
- **i18n covers UI chrome only.** README, guides and symbol docs stay as authored; 6 bundled locales over an EN fallback.
- **Playground runs examples client-side via `new Function`.** Intentional for a self-contained HTML page; sandboxing multi-language execution is out of scope.
- **YAML support is a documented subset.** The config reader handles scalars, inline lists, block sequences and nested string maps (s3/aliases/redirects). Anchors, multi-doc and exotic YAML degrade to skip with a warning. The OpenAPI extractor has its own, fuller, reader — but only for specs.

## Decisions worth knowing

<details><summary><b>D-1</b> — Zero runtime dependencies (except typescript)</summary>

The core pipeline has no runtime deps and the CLI uses only node builtins. This is why: the markdown parser, the YAML mini-readers (config.ts, theme-manifest.ts, extractors/openapi.ts), the highlighter and the search index are all hand-rolled. Cost: markdown is a CommonMark subset, YAML handles a documented subset only and degrades to skip on anchors/multi-doc, and the highlighters are heuristic. Benefit: `npx @brewdocs/cli` starts fast, there is no supply-chain surface in the build path, and every parse failure is ours to reason about.

Before adding a dependency, check whether the feature can degrade gracefully without one. If it cannot, treat it as an architecture decision and add a fact entry.

</details>

<details><summary><b>D-2</b> — The CLI runs TypeScript directly via tsx (no build step)</summary>

`packages/cli/bin/brewdocs.js` registers the tsx loader and imports `src/cli.ts`. There is no compile step before running the CLI, which is why `main` in core/plugin-sdk points at `src/index.ts`.

Consequence worth knowing: the published packages ship raw `.ts` (finding #8). That works for `npx brewdocs` because tsx is a dependency, but a plain-Node consumer importing `@brewdocs/core` gets ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING. Fixing #8 means introducing a real dist/exports map — and that interacts with this decision, so read both together.

</details>

<details><summary><b>D-3</b> — Language adapters are line-based heuristics, not ASTs</summary>

Rust/Java/C#/Ruby/Go adapters are regex + brace-counting over source lines (extractors/walk.ts folds logical declaration heads). They can be fooled by braces inside string literals. Exotic formatting degrades to 'symbol skipped', never a crash — errors warn and skip by convention.

Also: adapters only fire when JS/TS extraction finds **zero** symbols (extract.ts). A repo with one .ts file plus a whole Rust crate gets only the JS side. That is intentional but surprising.

</details>

<details><summary><b>D-4</b> — Cloud / domains / TLS / registry / federation are local control-plane emulations</summary>

There is no backend. `.cloud.json`, `.domains.json`, `.registry.json` and `.federation.json` sit next to the hosting directory and are the entire 'platform'. ACME issuance is out of scope; TLS is serve-side (the operator brings a PEM). This is honest in the README but easy to mistake for a hosted service when reading the command list — `brewdocs deploy` writes to a local directory unless `--storage s3` is passed.

</details>

<details><summary><b>D-5</b> — Escaping is centralized on purpose — do not add a local escape helper</summary>

`escapeHtml` in render.ts and in markdown.ts escape `& < > " '` so the same function is correct for text nodes and quoted attributes. If you need to emit HTML, reuse it. A local helper that escapes only `&<>` reintroduces INV-4, which was a shipped XSS.

Related: MDX-generated markup (content.ts transformMdx) is HTML we emit ourselves and must not be fed back through the markdown escaper — it is stashed behind sentinel tokens and spliced in afterwards.

</details>

<details><summary><b>D-6</b> — The incremental cache is extraction-only and keyed on content hashes</summary>

`.brewdocs/extract.json` caches the ExtractResult keyed on a fingerprint of sorted relpath+sha256 plus the plugin names. Render always rebuilds. Versioned builds pass `cache: false` because git-worktree churn makes the fingerprint useless. package-lock.json is excluded from the fingerprint (huge, irrelevant to the doc model).

</details>

## Findings

Severity and the write-up are human judgement. **Status is not**: every entry marked `fixed` names the check that proves it, and `npm run gate` fails if that check stops passing. Reproduce the whole table with `npm run gate`.

**6 fixed / 12 open** — 2 of the open ones are high or med-high.

| # | Severity | Finding | Status | Proven by |
| --- | --- | --- | --- | --- |
| 1 | high | serve bound every interface with auth off (RCE via npm postinstall) | fixed | `inv-1:serve-binds-loopback` |
| 2 | high | Unauthenticated build API rendered any absolute local path | fixed | `inv-3:source-confinement` |
| 3 | high | Attribute injection / XSS: escapeHtml did not escape quotes | fixed | `inv-4:escape-helpers-quote-safe` |
| 4 | high | resolveSite prefix-confusion read sibling sites | fixed | `inv-5:boundary-aware-containment` |
| 5 | med-high | Subdomain `..` escaped the hosting dir; CLI --name was never slugified | partial | `inv-6:subdomain-slug-guard` |
| 6 | med-high | emitRedirects writes outside outDir via a `from: "../x"` key | open | — |
| 7 | medium | publish.yml publishes on any v* tag with no typecheck or smoke build | open | — |
| 8 | medium | @brewdocs/core ships raw TypeScript; plain Node cannot import it | open | — |
| 9 | medium | API key scopes are stored and printed but never enforced | open | — |
| 10 | medium | Rate limiter trusts X-Forwarded-For unconditionally | open | — |
| 11 | medium | Analytics/registry endpoints leak when keys exist but no admin token is set | open | — |
| 12 | medium | Theme slot partials resolve relative to the manifest (arbitrary file read) | open | — |
| 13 | low | Pages workflow uses npm install instead of npm ci | open | — |
| 14 | low | Doc/reality drift (test counts, root package version, gitignored roadmap) | fixed | `map:up-to-date` |
| 15 | low | python adapter executes a bundled helper against the target tree | open | — |
| 16 | low | No CSRF/Origin check on write endpoints | open | — |
| 17 | low | No golden-output test for the renderer | open | — |
| 18 | low | api.test.ts was flaky under load (2 tests at a 30s timeout) | fixed | `npx vitest run packages/cli/src/api.test.ts` |

### How to close the open ones

- **#6** — aliases.ts: treat both `from` and the alias target as site-root-relative, resolve, and reject anything not under outDir.
- **#7** — publish.yml: call `npm run verify` (or add the typecheck + smoke steps) before the three npm publish steps.
- **#8** — Ship dist/ (remove it from .gitignore for the package, or build in prepublishOnly), add files: [dist], and an exports map with types. Read decision D-2 first — it explains why main points at src today.
- **#9** — Return the validated ApiKeyRecord from authenticate() instead of a boolean, then check the required scope per route. Or delete scopes and the flag so the surface stops advertising a boundary it does not have.
- **#10** — Only honour X-Forwarded-For behind an explicit --trust-proxy flag / known proxy list; otherwise key on req.socket.remoteAddress.
- **#11** — Require a key for the read endpoints too when keys are configured, or gate them behind a `read` scope (which pairs with finding #9).
- **#12** — theme-manifest.ts: resolve the partial against the source root and reject paths outside it — the same boundary-aware pattern as INV-3/INV-5.
- **#13** — Switch to `npm ci`.
- **#15** — Warn (or refuse) when the python adapter is the one that fires for a source that was fetched rather than a local path.
- **#16** — Reject cross-site Origin/Sec-Fetch-Site on POST endpoints.
- **#17** — Add a snapshot test over the example gallery's built HTML. The fuzz suite already builds every example, so the fixture is free.

## Working in this repo

**Pipeline.** `Source → extractFromSource → ExtractResult → buildModel → RenderModel → renderToHtml`. Everything else (deploy, markdown export, audit, drift) is a consumer of that chain.

**Conventions.** ESM with `node:`-prefixed imports and `.js` extensions in specifiers (required for ESM resolution under tsx/vitest). Tests import the workspace via the `@brewdocs/core` alias; fixtures go in `fs.mkdtempSync(os.tmpdir())`; describe titles carry version tags (`"v2.0 …"`).

**Errors degrade, they do not crash.** A bad symbol, plugin or adapter warns and is skipped. The build is expected to produce a page even from messy input — preserve that.

**Adding a top-level core module** needs no `files` allowlist edit (the allowlist is `src` wholesale) — but always `npm pack --dry-run` before a release. A stale allowlist once shipped a 3.0.0 with 19 missing modules.

**Commands.** `npm test` · `npm run typecheck` · `npx vitest run <path>` · `npx vitest run <path> -t "name"` · `npm run brewdocs -- build ./docs --theme ink --out docs-site`. Full suite takes a few minutes; the fuzz suite alone is ~30s.

**When you change a trust boundary**, update `docs/map/facts/invariants.json` in the same commit and run `npm run map`. The gate executes each finding's `verify` command, so an entry marked `fixed` that regresses turns the build red instead of going quiet.
