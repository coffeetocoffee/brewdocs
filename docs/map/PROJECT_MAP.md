# Project Map — brewdocs

> **Generated file. Do not edit.** Run `npm run map` to regenerate;
> CI (`npm run map:check`) fails if this is out of date.
>
> Facts a machine cannot infer live in [`facts/`](./facts) and are reviewed by humans.
> Everything below with a number in it is parsed from the source tree.

_Generated: 2026-10-05_

## What this is

A zero-config documentation generator for code. Point it at a local path, an npm package name, or a GitHub URL and it produces one self-contained HTML page (plus a queryable `docmodel.json`). It also ships a hosting server, a CLI with coverage/diff/gate tooling, language adapters beyond JS/TS, and an MCP server so agents can read the same model.

The product's whole job is rendering prose from repositories **you do not own** — READMEs, doc comments, git tag names. That is the threat model everything in `facts/invariants.json` follows from.

## Shape

| Package | Version | Role | Source | Tests |
| --- | --- | --- | --- | --- |
| `@brewdocs/cli` | 4.4.1 | commands + hosting server | 4 files / 3,371 loc | 10 files / 1,588 loc |
| `@brewdocs/core` | 4.4.1 | pipeline: extract → model → render | 60 files / 15,331 loc | 45 files / 5,651 loc |
| `@brewdocs/plugin-sdk` | 4.4.1 | adapter/hook contracts | 1 files / 57 loc | 1 files / 394 loc |

**393 test declarations across 56 files** — parsed from the tree, not typed.

> 14 file(s) declare tests inside a fixture loop, so a `vitest` run reports more cases than the declaration count above: `mcp-http.test.ts`, `audit.test.ts`, `ci.test.ts`, `draft.test.ts`, `drift.test.ts`, `federation.test.ts`, `fuzz.test.ts`, `harvest.test.ts`, `languages.test.ts`, `openapi.test.ts`, `prove.test.ts`, `realworld.test.ts`, `robust.test.ts`, `workspaces.test.ts`. That is expected — the declaration count is the stable number.

## Trust boundaries

Every entry point that accepts caller-controlled input, and the exact guard on it. This is derived from `packages/cli/src/server.ts` on every run.

| Endpoint | Method | Guards | Defined at |
| --- | --- | --- | --- |
| `/api/build` | POST | `authorize` | `packages/cli/src/server.ts:694` |
| `/api/export` | POST | `authorize` | `packages/cli/src/server.ts:764` |
| `/api/sites` | GET | `authorizeRead` | `packages/cli/src/server.ts:830` |
| `/api/registry` | GET | `authorizeRead` | `packages/cli/src/server.ts:842` |
| `/mcp` | POST | `authorizeRead` | `packages/cli/src/server.ts:868` |
| `/api/gap` | GET | `authorizeRead` | `packages/cli/src/server.ts:913` |
| `/api/search` | GET | `authorizeRead` | `packages/cli/src/server.ts:928` |
| `/api/markdown` | POST | `authorize` | `packages/cli/src/server.ts:946` |
| `/api/stats` | GET | `authorizeRead` | `packages/cli/src/server.ts:992` |
| `/` | GET | **none** | `packages/cli/src/server.ts:1040` |
| `/dashboard` | GET | **none** | `packages/cli/src/server.ts:1056` |

### Invariants a change must not break

- **INV-1** — The hosting server binds 127.0.0.1 unless the operator passes --host. A non-loopback bind with no token and no keys mints a token before serving.
  - _why:_ `server.listen(port)` binds every interface on Node. The build API can run npm install, so an open instance on a LAN is remote code execution, and the startup banner used to say 'localhost' while the socket said otherwise.
  - _enforced by:_ packages/cli/src/server.test.ts (source confinement), packages/cli/src/cli-commands.test.ts (isLoopbackHost)
- **INV-2** — Fetching an npm package must pass --ignore-scripts and must not pass the parent process environment through to the child.
  - _why:_ BrewDocs only needs a package's README and source to build docs. Lifecycle scripts (postinstall et al.) are arbitrary code execution from a caller-supplied name, reachable from the build API.
  - _enforced by:_ packages/core/test/resolve.test.ts
- **INV-3** — Every endpoint that reads a caller-supplied local path must resolve it against sourceRoot and refuse anything outside with 403. Realpath first, so neither .. nor a symlink escapes.
  - _why:_ A build endpoint that renders any readable directory is a file-disclosure primitive; /api/export returned the HTML directly, so a README containing a key was disclosed verbatim.
  - _enforced by:_ packages/cli/src/server.test.ts (Phase 5 — source confinement)
- **INV-4** — HTML escaping has one implementation (packages/core/src/escape.ts) that escapes " and ' as well as & < >, because untrusted values are interpolated into quoted attributes (href, value, title).
  - _why:_ This is the contract, not one call site. The XSS shipped because escapeHtml escaped only &<>; local copies then multiplied (highlight, workspaces, registry, federation) and the gate only checked three fixed files. One source plus an all-files scan keeps a new quote-blind helper from slipping in.
  - _enforced by:_ packages/core/src/escape.ts (the single escaper) + scripts/gate.mjs (inv-4:escape-helpers-quote-safe scans every source file) + packages/core/test/escape.test.ts
- **INV-5** — Path containment must be boundary-aware: resolve the candidate and require it to equal the root or start with root + path.sep. Never use a bare startsWith.
  - _why:_ startsWith accepted a sibling whose name shared the target's prefix (/s/acme/../acme-secret resolved outside hosting/acme). The existing traversal test passed for the wrong reason — Node's URL normalizer, not the code.
  - _enforced by:_ packages/cli/src/server.test.ts (prefix-confusion, dots-only subdomains)
- **INV-6** — A site subdomain must be a plain DNS-ish slug; dots-only and separator-bearing values are refused before any path resolution.
  - _why:_ The Host header is caller-controlled and `...brewdocs.dev` slugifies to `..`, which reaches above the hosting directory.
  - _enforced by:_ packages/cli/src/server.test.ts (rejects dots-only / separator-bearing subdomains)
- **INV-7** — A URL placed in href/src must have its scheme validated; javascript:, vbscript: and data: are dropped, including control-character-smuggled forms.
  - _why:_ Markdown link targets come from third-party prose. `java\nscript:` is still javascript: to a browser, so the scheme check must strip control characters before sniffing.
  - _enforced by:_ packages/core/test/markdown.test.ts
- **INV-8** — Any writer that takes a site-root-relative path from config must resolve it against the output directory and refuse anything outside. Same boundary-aware rule as INV-5: no bare startsWith.
  - _why:_ `redirects:` and `aliases:` in brewdocs.yml are repo-controlled, so a `from: "../x.html"` key could create files above the build output. Reachable from any repo you build docs for.
  - _enforced by:_ packages/core/test/aliases.test.ts (v3.8 containment of generated output)
- **INV-9** — A theme slot partial path must be confined to the manifest's source root before it is read.
  - _why:_ Slot values are repo-controlled config. A `themes/brand.yml` shipped by the repo being documented could name `../../id_rsa`; the build would read it and can embed it in a page the user then publishes.
  - _enforced by:_ packages/plugin-sdk/test/v2.test.ts (confines slot partials to the source root)
- **INV-10** — A POST (write) request must be refused with 403 when the browser signals a cross-site origin: Origin must equal the Host we were reached on, and Sec-Fetch-Site must be same-origin or none.
  - _why:_ Any web page can POST to an open instance on the user's LAN with a simple request and no preflight. Non-browser clients send neither header and stay allowed.
  - _enforced by:_ packages/cli/src/server.test.ts (refuses cross-site POST /api/build)
- **INV-11** — CI workflows must install with npm ci, never npm install.
  - _why:_ A lockfile-ignoring install on a tree containing package.json scripts is a supply-chain surface; the Pages workflow ran on a repository with pages: write and id-token: write granted.
  - _enforced by:_ scripts/gate.mjs (inv-11:ci-uses-npm-ci)
- **INV-12** — The published @brewdocs/core must resolve to compiled JS (dist/), not raw TypeScript, so a plain-Node consumer can import it.
  - _why:_ Core shipped src/**/*.ts; `import '@brewdocs/core'` under plain Node threw ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING. Dev/test keep using source via tsconfig paths + a vitest alias, so only the published entry changes.
  - _enforced by:_ scripts/gate.mjs (inv-12:core-ships-compiled) + CI pack smoke
- **INV-13** — A per-user API key must only perform the operations its scopes include; a write endpoint with the wrong scope returns 403.
  - _why:_ keys.ts stored and printed scopes that server.ts never read, so a `--scope build` key could export and render markdown too. The surface advertised a boundary it did not have.
  - _enforced by:_ packages/cli/src/server.test.ts (enforces the key's scopes per write endpoint)
- **INV-14** — A release tag must run the verify gate (typecheck + map + security invariants + tests) before publishing.
  - _why:_ publish.yml published three packages on any v* tag after only `npm ci` + `npm test`; provenance attests where it was built, not that it works.
  - _enforced by:_ scripts/gate.mjs (inv-14:release-runs-verify)
- **INV-15** — X-Forwarded-For may only set the rate-limit client identity behind an explicit opt-in (trustProxy / BREWDOCS_TRUST_PROXY=1); otherwise the socket address is used.
  - _why:_ The header is caller-controlled, so honouring it unconditionally let a client defeat the only brake on the expensive /api/build path by rotating the value.
  - _enforced by:_ scripts/gate.mjs (inv-15:trust-proxy-opt-in)
- **INV-16** — Read endpoints that expose deployment/registry/federation metadata must 401 once auth is configured (admin token or keys); only a fully unauthenticated instance leaves them open.
  - _why:_ needsAuth was driven by the token alone, so an instance with keys but no BREWDOCS_TOKEN leaked /api/sites, /api/registry, /api/search and the stats rollup anonymously.
  - _enforced by:_ scripts/gate.mjs (inv-16:read-endpoints-guarded) + packages/cli/src/server.test.ts (guards read endpoints once auth is configured)
- **INV-17** — An adapter that executes code against the source tree (python) must refuse a fetched (npm/git) source and run only for a locally chosen one.
  - _why:_ The python adapter shells out to a bundled AST helper; running it against a package the user did not choose turns a doc build into code execution on attacker-supplied input.
  - _enforced by:_ scripts/gate.mjs (inv-17:python-refuses-fetched)
- **INV-18** — The renderer must have a golden-output snapshot test over a full page, including hostile inputs.
  - _why:_ A renderer that emits its own CSS/JS had no output test, which is how the attribute-injection XSS (#3) survived hundreds of green unit tests that only checked substrings.
  - _enforced by:_ scripts/gate.mjs (inv-18:renderer-golden)
- **INV-19** — Every write endpoint (POST) must carry an explicit guard (authorize / guardSource / requireSiteAccess) before it acts on caller input.
  - _why:_ The build/export/markdown APIs are the RCE and file-disclosure surface. A new POST route added without a guard would ship open; the gate asserts the guard from the routes it parses out of server.ts.
  - _enforced by:_ scripts/gate.mjs (inv-19:write-endpoints-guarded)
- **INV-20** — A fetched (npm/git) source must not be able to name its own plugins: plugins listed in the source's brewdocs.yml are ignored unless the source was chosen locally. Plugins the operator passed explicitly (--plugins) still load.
  - _why:_ A plugin is arbitrary code — loaded via require/import, with no signature and no sandbox. The specifier is read from the source's own brewdocs.yml, and BrewDocs' stated job is rendering repos you do not own, so honoring it turns every doc build into remote code execution on the operator's machine. This is the same threat INV-17 already refuses for the python adapter, in a wider blast radius. The subtle part is propagation:  must survive every hop from resolveInput to resolveSetup, and each hop that rebuilt a Source without it silently re-enabled the repo's plugins. That is how the first version of this fix was bypassed three times (per-version worktree, extractVersion, and the CLI build command) before the gate check was written to assert all of them.
  - _enforced by:_ packages/core/test/plugin-fetched.test.ts + scripts/gate.mjs (inv-20:fetched-source-cannot-name-plugins, which asserts the guard and every Source re-construction site)
- **INV-21** — The HTTP MCP transport (POST /mcp?site=<sub>) must be gated like the other reads — 401 once auth is configured, and a private site additionally requires its access token — and it must record every tools/call into the analytics store.
  - _why:_ This endpoint exposes a site's docmodel to agents, so an unauthenticated caller on a server with auth configured must not reach it, and a private site's docs must not leak through the agent-shaped door when they are closed on the HTML door. Recording the call is the endpoint's whole purpose: without it, the product never learns which symbols were asked for and not found, which is the gap this release exists to close.
  - _enforced by:_ scripts/gate.mjs (inv-21:mcp-http-guarded) + packages/cli/src/mcp-http.test.ts (auth, private-site token, telemetry round-trip)
- **INV-22** — The stdio and HTTP MCP transports must answer through one shared message handler; a tool added or changed must behave identically on both.
  - _why:_ Two transports over the same protocol is exactly the shape that lets a fix land in one path and not the other — the same failure mode that let the plugin 'fetched' guard be bypassed three times (INV-20). One handler means the protocol has a single implementation to keep correct.
  - _enforced by:_ scripts/gate.mjs (inv-22:mcp-one-protocol-handler) + packages/core/test/mcp.test.ts (handleMcpMessage is the single dispatcher)

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
| Pageview/build counters, top paths, and (v4.5) MCP tool-call query telemetry | `hosting/.analytics.json` | cli/src/server.ts StatsStore — recordView/recordBuild/recordToolCall |
| Drift baseline (code vs docs fingerprints per symbol) | `<src>/.brewdocs/drift.json` | core/src/drift.ts — `brewdocs drift --record` |
| Coverage trend history | `<src>/.brewdocs/coverage.json` | core/src/doctor.ts — `brewdocs doctor --record` |
| Extraction cache (content-hash keyed) | `<src>/.brewdocs/extract.json` | core/src/cache.ts |
| Machine-readable API artifact emitted by every build | `<out>/docmodel.json` | core/src/docmodel.ts (schema brewdocs/docmodel@1) |

## Boundaries and non-goals

- **No backend service.** Deployment, orgs, domains, TLS issuance, analytics, the plugin registry and federated search are local emulations backed by JSON files beside the hosting dir — there is deliberately no network service. `brewdocs deploy` writes to a local directory unless `--storage s3` is given; the registry records a content hash per entry (`registry verify`) so it is tamper-evident without a server. A hosted control plane would be a separate product, not a mode of this one.
- **No real ACME.** TLS is serve-side: the operator supplies a certificate. `createSecureServer` wires it into the same request pipeline. Corollary for testing: because there is nothing to issue against, the TLS surface is verified **fail-fast** — invalid credentials throw and a missing cert file degrades to `undefined` — not end-to-end. An 'actually serves HTTPS' test would require certificate issuance, which boundary #1 and D-4 rule out.
- **No remote cache.** Both caches are local, on disk: extraction (`.brewdocs/extract.json`) and rendering (`.brewdocs/render.json`, opt-in via `--cache`). There is no shared or remote cache — a cache is per-source-deck, never uploaded.
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

<details><summary><b>D-6</b> — Both caches are local, content-hash keyed, and opt-in</summary>

Two caches sit in `.brewdocs/`, both local and never uploaded. Extraction (`.brewdocs/extract.json`) caches the ExtractResult keyed on a fingerprint of sorted relpath+sha256 plus the plugin names. Rendering (`.brewdocs/render.json`, added in v4.1) caches rendered pages keyed on `renderFingerprint(model, opts)` — real because rendering is not free once themes/search/export are in play — and is gated on `--cache` (or `config.cache`).

Versioned builds pass `cache: false` because git-worktree churn makes the fingerprint useless. package-lock.json is excluded from the extraction fingerprint (huge, irrelevant to the doc model).

Drift note: this entry and boundary #3 said 'rendering always runs' for three releases after v4.1 made that false. Nothing in `map:check` catches stale *prose* — `facts/*.json` is hand-written source, copied through faithfully. Read these files when you touch the pipeline; the generator will not warn you.

</details>

<details><summary><b>D-7</b> — Federated search ranks by term counting — no embeddings, no crawl</summary>

`searchFederation` (federation.ts) scores every indexed symbol with plain substring term matching: a symbol-name hit adds 5 per query term, body hits add their (capped-at-10) occurrence count per term, and the repo name is folded into the body so a repo-name query surfaces that repo's symbols. Results sort by score. There is no embedding model, no vector index and no web crawl — the index is exactly the local `docmodel.json` files added via `brewdocs federate`.

Consequence, and why this is recorded: ranking is *lexical*, so it is fast and dependency-free but blind to synonyms and paraphrase. 'auth' will not find a symbol documented as 'login'. That is the tradeoff (D-1 keeps the pipeline dependency-free); a semantic ranker is a separate product decision, not a bug to file. The in-page search reimplements the same scoring in vanilla JS, so the two stay intentionally in sync.

</details>

<details><summary><b>D-8</b> — Config validation is shape-and-enum only; it warns and drops, never throws</summary>

`validateConfig` (config.ts) checks three things and nothing more: the key is known (with a Levenshtein 'did you mean'), the value has the right JSON shape, and — since v4.4 — a key with a fixed value set (`storage` local|s3, `locale` a bundled code) holds one of them. Anything deeper (a valid bucket name, a real path, a coherent combination of flags) is *not* validated.

Why enums got their own check: `matchesKind` sees `storage` as a plain string, so `storage: lcoal` was a legal value, passed validation, and then no-op'd — `buildStorage` compares against `"s3"` and quietly deployed locally. The whole point of this function is to turn a silently-ignored setting into a warning, so a typo'd enum was the one case it most needed to catch. `locale` accepts region/base forms (`id-ID`, `EN`) by comparing the base code, mirroring `normalizeLocale`.

Two conventions hold. It degrades — warn and drop the key so defaults apply — never throws (a malformed config used to be swallowed whole). And warnings are de-duplicated per message per process (`warnedMessages`): `loadConfig` runs many times in one build (cache, content, theme, deploy, every command), so without this a single typo printed five times.

</details>

<details><summary><b>D-9</b> — Plugins are trusted code, so only the operator may choose them</summary>

A plugin is arbitrary code: loadPlugin resolves the specifier with createRequire and imports it, with no signature, no sandbox and no capability limit (D-1 keeps the runtime dependency-free, so there is no isolation mechanism to lean on). The question is therefore not whether a plugin is safe — it is who is allowed to name one. A locally chosen repo may name its own plugins: that is the plugin feature. A fetched repo may not, because BrewDocs exists to render codebases the operator does not own, and a brewdocs.yml that can name a plugin turns every doc build into remote code execution (finding #19, INV-20). Plugins passed explicitly with --plugins always load, on a fetched source or not, because that is the operator decision rather than the repo. The general rule this encodes: anything the SOURCE tree controls (config values that select code, theme slot paths, redirects) is untrusted input, and anything the OPERATOR passes on the command line is a decision. If a new config key can cause code to load rather than merely change output, it belongs on the untrusted side of that line.

</details>

<details><summary><b>D-10</b> — MCP query telemetry is local-only, stored beside the views/builds it sits next to</summary>

v4.5 closes the feedback loop: agents query a deployed site's docmodel over POST /mcp, and every tools/call (tool, query, hit/miss) is written into the same hosting-side .analytics.json that already holds pageviews and builds. `brewdocs gap` reads it back and answers "which symbols did people ask for and not find". The decision is where that data lives: locally, next to the site, exactly like views and builds — no backend, no phone-home, no query text leaving the machine. That keeps the no-backend posture (boundary #1) intact and makes the privacy cost identical to the pageview counter that was already there. It also keeps the feature honest about its own limits: a site nobody queries produces an empty gap report, and an empty report is not evidence that the docs are complete. A hosted analytics service would be a different product (boundary #1), not an extension of this store.

</details>

## Findings

Severity and the write-up are human judgement. **Status is not**: every entry marked `fixed` names the check that proves it, and `npm run gate` fails if that check stops passing. Reproduce the whole table with `npm run gate`.

**19 fixed / 0 open** — 0 of the not-yet-fixed ones are high or med-high.

| # | Severity | Finding | Status | Proven by |
| --- | --- | --- | --- | --- |
| 1 | high | serve bound every interface with auth off (RCE via npm postinstall) | fixed | `inv-1:serve-binds-loopback` |
| 2 | high | Unauthenticated build API rendered any absolute local path | fixed | `inv-3:source-confinement` |
| 3 | high | Attribute injection / XSS: escapeHtml did not escape quotes | fixed | `inv-4:escape-helpers-quote-safe` |
| 4 | high | resolveSite prefix-confusion read sibling sites | fixed | `inv-5:boundary-aware-containment` |
| 5 | med-high | Subdomain `..` escaped the hosting dir; CLI --name was never slugified | fixed | `inv-6:subdomain-slug-guard` |
| 6 | med-high | emitRedirects wrote outside outDir via a `from: "../x"` key | fixed | `inv-8:output-dir-containment` |
| 7 | medium | publish.yml publishes on any v* tag with no typecheck or smoke build | fixed | `inv-14:release-runs-verify` |
| 8 | medium | @brewdocs/core ships raw TypeScript; plain Node cannot import it | fixed | `inv-12:core-ships-compiled` |
| 9 | medium | API key scopes are stored and printed but never enforced | fixed | `inv-13:key-scopes-enforced` |
| 10 | medium | Rate limiter trusts X-Forwarded-For unconditionally | fixed | `inv-15:trust-proxy-opt-in` |
| 11 | medium | Analytics/registry endpoints leak when keys exist but no admin token is set | fixed | `inv-16:read-endpoints-guarded` |
| 12 | medium | Theme slot partials resolved relative to the manifest (arbitrary file read) | fixed | `inv-9:theme-slot-confinement` |
| 13 | low | Pages workflow uses npm install instead of npm ci | fixed | `inv-11:ci-uses-npm-ci` |
| 14 | low | Doc/reality drift (test counts, root package version, gitignored roadmap) | fixed | `map:up-to-date` |
| 15 | low | python adapter executes a bundled helper against the target tree | fixed | `inv-17:python-refuses-fetched` |
| 16 | low | No CSRF/Origin check on write endpoints | fixed | `npx vitest run packages/cli/src/server.test.ts` |
| 17 | low | No golden-output test for the renderer | fixed | `inv-18:renderer-golden` |
| 18 | low | api.test.ts was flaky under load (2 tests at a 30s timeout) | fixed | `npx vitest run packages/cli/src/api.test.ts` |
| 19 | high | A fetched repo brewdocs.yml could name a plugin, executing arbitrary code at build time (RCE) | fixed | `inv-20:fetched-source-cannot-name-plugins` |

## Working in this repo

**Pipeline.** `Source → extractFromSource → ExtractResult → buildModel → RenderModel → renderToHtml`. Everything else (deploy, markdown export, audit, drift) is a consumer of that chain.

**Conventions.** ESM with `node:`-prefixed imports and `.js` extensions in specifiers (required for ESM resolution under tsx/vitest). Tests import the workspace via the `@brewdocs/core` alias; fixtures go in `fs.mkdtempSync(os.tmpdir())`; describe titles carry version tags (`"v2.0 …"`).

**Errors degrade, they do not crash.** A bad symbol, plugin or adapter warns and is skipped. The build is expected to produce a page even from messy input — preserve that.

**Adding a top-level core module** needs no `files` allowlist edit (the allowlist is `dist`, wholesale) — but always `npm pack --dry-run` before a release. A stale allowlist once shipped a 3.0.0 with 19 missing modules.

**Commands.** `npm test` · `npm run typecheck` · `npx vitest run <path>` · `npx vitest run <path> -t "name"` · `npm run brewdocs -- build ./docs --theme ink --out docs-site`. Full suite takes a few minutes; the fuzz suite alone is ~30s.

**When you change a trust boundary**, update `docs/map/facts/invariants.json` in the same commit and run `npm run map`. The gate executes each finding's `verify` command, so an entry marked `fixed` that regresses turns the build red instead of going quiet.
