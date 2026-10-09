# Project Map — brewdocs

> **Generated file. Do not edit.** Run `npm run map` to regenerate;
> CI (`npm run map:check`) fails if this is out of date.
>
> Facts a machine cannot infer live in [`facts/`](./facts) and are reviewed by humans.
> Everything below with a number in it is parsed from the source tree.

_Generated: 2026-10-09_

## What this is

A zero-config documentation generator for code. Point it at a local path, an npm package name, or a GitHub URL and it produces one self-contained HTML page (plus a queryable `docmodel.json`). It also ships a hosting server, a CLI with coverage/diff/gate tooling, language adapters beyond JS/TS, and an MCP server so agents can read the same model.

The product's whole job is rendering prose from repositories **you do not own** — READMEs, doc comments, git tag names. That is the threat model everything in `facts/invariants.json` follows from.

## Shape

| Package | Version | Role | Source | Tests |
| --- | --- | --- | --- | --- |
| `@brewdocs/cli` | 4.7.0 | commands + hosting server | 5 files / 3,904 loc | 12 files / 2,385 loc |
| `@brewdocs/core` | 4.7.0 | pipeline: extract → model → render | 61 files / 15,414 loc | 47 files / 6,040 loc |
| `@brewdocs/plugin-sdk` | 4.7.0 | adapter/hook contracts | 1 files / 57 loc | 1 files / 394 loc |

**430 test declarations across 60 files** — parsed from the tree, not typed.

> 16 file(s) declare tests inside a fixture loop, so a `vitest` run reports more cases than the declaration count above: `mcp-http.test.ts`, `v47.test.ts`, `audit.test.ts`, `ci.test.ts`, `draft.test.ts`, `drift.test.ts`, `examples.test.ts`, `federation.test.ts`, `harvest.test.ts`, `hostile.test.ts`, `languages.test.ts`, `openapi.test.ts`, `prove.test.ts`, `realworld.test.ts`, `robust.test.ts`, `workspaces.test.ts`. That is expected — the declaration count is the stable number.

## Trust boundaries

Every entry point that accepts caller-controlled input, and the exact guard on it. This is derived from `packages/cli/src/server.ts` on every run.

| Endpoint | Method | Guards | Defined at |
| --- | --- | --- | --- |
| `/api/build` | POST | `authorize`, `sourceRoot` | `packages/cli/src/server.ts:1070` |
| `/api/export` | POST | `authorize`, `sourceRoot` | `packages/cli/src/server.ts:1133` |
| `/api/sites` | GET | `authorizeRead` | `packages/cli/src/server.ts:1192` |
| `/api/registry` | GET | `authorizeRead` | `packages/cli/src/server.ts:1204` |
| `/mcp` | POST | `authorizeRead`, `requireSiteAccess` | `packages/cli/src/server.ts:1230` |
| `/api/gap` | GET | `authorizeRead` | `packages/cli/src/server.ts:1286` |
| `/api/search` | GET | `authorizeRead` | `packages/cli/src/server.ts:1301` |
| `/api/markdown` | POST | `authorize`, `sourceRoot` | `packages/cli/src/server.ts:1319` |
| `/api/stats` | GET | `authorizeRead`, `requireSiteAccess` | `packages/cli/src/server.ts:1361` |
| `/` | GET | **none** | `packages/cli/src/server.ts:1426` |
| `/dashboard` | GET | `requireSiteAccess` | `packages/cli/src/server.ts:1442` |

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
- **INV-19** — Every write endpoint (POST) must carry an explicit guard (authorize / guardSource) before it acts on caller input; /mcp is verified for read authorization and site access.
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
- **INV-23** — Every comparison against a credential (token, token hash, key hash, domain verification token) must go through safeEqual in core/src/compare.ts — never a bare === — and safeEqual must never throw on a length mismatch.
  - _why:_ A === on a secret is not guaranteed constant-time, so each compared byte leaks a little timing signal (finding #20). The sites were spread across four modules (server.ts site access, the admin Bearer compares, cloud.ts org membership, keys.ts key lookup, domains.ts verification token), which is the same one-fix-many-copies shape as the escaping bug (INV-4) — so the gate scans every source file for a secret-ish identifier beside ===/!==, not a fixed file list. The wrapper (rather than a raw crypto.timingSafeEqual) is load-bearing: timingSafeEqual throws RangeError on a length mismatch, and a throw in this server exits the process (finding #21), so the naive swap would have traded a timing leak for an unauthenticated crash.
  - _enforced by:_ scripts/gate.mjs (inv-23:credentials-compared-in-constant-time) + packages/core/test/compare.test.ts (length mismatch, UTF-8 semantics, non-strings) + packages/cli/src/v46.test.ts (wrong-length token over HTTP)
- **INV-24** — A single request must not be able to kill the process: every request listener is guarded, caller-controlled parsing (the request line, percent-decoding) answers 400, and every file stream handles its own error.
  - _why:_ An async request listener that throws rejects a promise with no handler attached and Node exits the process; a synchronous listener that throws does the same. Requests are untrusted input, so one malformed request line (GET //[ — new URL() throws) or one client that abandons a POST mid-body (the body read throws aborted) was an unauthenticated denial of service against both the hosting server and the preview server (finding #21, reproduced by execution). An unhandled error on fs.createReadStream(...).pipe(res) is the same class: a file that vanishes between the existence check and the open takes the process with it.
  - _enforced by:_ scripts/gate.mjs (inv-24:request-cannot-kill-the-process) + packages/cli/src/v46.test.ts (hostile request line, lone percent-escape, aborted body, wrong-length token — each asserts the next request still answers 200)
- **INV-25** — A stored credential hash must not authenticate: authentication hashes what it is presented, while only operator-side mutations (add/remove member) may accept an already-hashed value.
  - _why:_ canAccessOrg used normalizeKeyHash, which passes a non-bd_live_ string through untouched, so presenting a member's stored keyHash back as the Bearer token returned 200 (finding #22, reproduced over HTTP). The stored hash is an artifact at rest; if it is also a credential then hashing buys nothing and anyone who can read .cloud.json holds every member key in usable form. validateKey in keys.ts never had the hole (it always hashes, so a hash double-hashes and misses) — the two key stores disagreed about what a credential is, which is why the asymmetry stayed invisible.
  - _enforced by:_ scripts/gate.mjs (inv-25:stored-hash-is-not-a-credential) + packages/core/test/cloud.test.ts (stored hash rejected, raw key still accepted)
- **INV-26** — A site manifest that exists but cannot be read must fail closed: only ENOENT is 'missing' (benign), every other read or parse failure is 'unreadable' and every consumer refuses.
  - _why:_ deploySite and setDraftExpiry rewrite .brewdocs.json with a plain non-atomic writeFileSync, so a crash or a full disk leaves a truncated file; readManifest used to answer undefined for every failure and requireSiteAccess reads an absent tokenHash as public, so a damaged manifest silently published a private site (finding #23, reproduced: 401 intact, 200 truncated, same anonymous request). The states are deliberately distinct: a MISSING manifest stays benign (a hand-dropped directory serves as public, D-12) because whoever can delete the manifest can equally rewrite its visibility — absence is not the weakness, an unreadable file is, because the file's real contents are unknown rather than 'public'.
  - _enforced by:_ scripts/gate.mjs (inv-26:damaged-manifest-fails-closed) + packages/cli/src/v46.test.ts (truncated manifest refused on the site route, /mcp, /dashboard and /api/stats; listed as private in /api/sites; repairing the file restores service)
- **INV-27** — A site name taken from ?site= must pass the same slug guard as routing (SAFE_SUBDOMAIN) before any filesystem access; readManifest is the chokepoint and /mcp builds its docmodel path only after the manifest read succeeds.
  - _why:_ resolveSite validated /s/ and Host routing but the query-param routes (/mcp, /dashboard, /api/stats) passed the raw parameter to path.join, so ?site=../sibling read a directory above the hosting root — 200 on /mcp with its docmodel and the outside title rendered by /dashboard (finding #24, reproduced). The two routing forms and the three query-param forms must agree about what a site name is; validating inside readManifest makes that structural instead of five copies of the same check.
  - _enforced by:_ scripts/gate.mjs (inv-27:site-param-cannot-leave-hosting) + packages/cli/src/v46.test.ts (?site=../outside answers 404 on /mcp and /dashboard, and the outside title never renders)
- **INV-28** — A private site is always token-gated: every private deploy records a tokenHash, and a private manifest without one is refused rather than read as public.
  - _why:_ requireSiteAccess treated an absent tokenHash as 'nothing to check' — but private: true in brewdocs.yml set visibility without minting a token (only the --private/--draft flags minted), so the documented config path produced a private site that served anonymously (finding #25, reproduced by execution; the CLI even printed 'token: undefined'). Both halves are needed: the CLI mint keeps new deploys correct, and the server refusal is the backstop for hand-edited and pre-fix manifests, which would otherwise stay open forever.
  - _enforced by:_ scripts/gate.mjs (inv-28:private-site-always-token-gated) + packages/cli/src/v46.test.ts (hashless private manifest refused on /s/, /dashboard and /mcp) + packages/cli/src/cli-commands.test.ts (private: true in config records a tokenHash)
- **INV-29** — An unreadable key store counts as 'auth IS configured', not as 'no auth': needsAuth is true while .keys.json exists but does not parse as an array, and every gated route refuses until it is repaired.
  - _why:_ loadKeys degrades every failure to [] and needsAuth was Boolean(token) || loadKeys(...).length > 0, so a damaged store read as 'no auth configured' and every gated read and write answered anonymously — reproduced with a corrupt store (GET /api/sites -> 200) and with {} (POST /api/export -> 200) (finding #26). This is the authorization twin of the manifest fail-open (#23): a store that cannot be read must refuse, not default to open. loadKeys also no longer hands a non-array document to callers, where {} used to reach .find and throw.
  - _enforced by:_ scripts/gate.mjs (inv-29:unreadable-key-store-refuses) + packages/cli/src/v46.test.ts (corrupt store: /api/sites and /api/build answer 401, and the previously valid key cannot authenticate either)
- **INV-30** — A theme manifest's vars and css must not be able to terminate the <style> element: '<' is neutralized before interpolation.
  - _why:_ HTML ends a raw-text <style> element at the literal sequence '</style', and escapeHtml cannot help inside a raw-text element. themeVars and the manifest css string were interpolated raw, so a repo shipping themes/brand.yml with vars: { accent: '</style><script>…' } got a live script in the built page (finding #27, reproduced by execution). cssSafe in render.ts neutralizes '<' into the CSS escape '\3c ', keeping the style element intact.
  - _enforced by:_ scripts/gate.mjs (inv-30:style-channel-cannot-break-out) + packages/core/test/hostile.test.ts (hostile manifest vars and css produce no live script and style count is 1)
- **INV-31** — Every POST route must read its body through the capped reader: a content-length over 1 MiB answers 413 before the body is read, and a running byte count answers 413 the moment it crosses the cap (chunked or lying clients), with the response written before the socket closes.
  - _why:_ Four routes each read the body with an unbounded loop, so one unauthenticated POST could grow the heap until the process died — and the string concatenation was quadratic on top (finding #28). The rate limiter caps frequency, not size, and the default `brewdocs serve` posture is unauthenticated, so this was reachable by any caller. The refusal must write the 413 BEFORE closing the socket: destroying the request at refusal time races the response write, and a socket closed with unread bytes queued makes the kernel send RST, discarding the answer (verified by execution). So readBody drains the refused remainder briefly (a deadline bounds an endless body) rather than destroying immediately.
  - _enforced by:_ scripts/gate.mjs (inv-31:post-bodies-are-capped) + packages/cli/src/v47.test.ts (413 on all four routes, chunked without content-length, header-only refusal, exact-cap boundary)
- **INV-32** — A numeric protection option from the environment must be finite and at least its floor (1 for rate limit, rate window and build concurrency; 0 for queue depth, where 0 means 'no queueing'); an unusable value warns and falls back to the default. The embedding API channel keeps 0 legal where it means 'no capacity'.
  - _why:_ `Number("")` is 0 and `Number("-5")` is -5, and the old check only rejected NaN — so `BREWDOCS_RATE_LIMIT=` (the normal shape in a .env, a Dockerfile, or `docker run -e`) read as 'limit 0', which bricked /api/build, /api/export, /api/markdown and /mcp after one call, and a negative maxConcurrentBuilds pinned the queue forever. Nothing warned (finding #29). This is the env channel of the same contract config.ts applies to brewdocs.yml (D-8: warn and drop, never throw); it had no equivalent. The explicit-value channel stays permissive because there a 0 is a deliberate caller choice (the queue-full 503 test writes maxConcurrentBuilds: 0).
  - _enforced by:_ scripts/gate.mjs (inv-32:env-numeric-options-validated) + packages/cli/src/v47.test.ts (empty/whitespace/negative/0/non-numeric fall back with a warning; BREWDOCS_RATE_LIMIT= no longer 429s the second request)
- **INV-33** — No test may bind every interface: every `.listen(` in a *.test.ts must name 127.0.0.1, and the shared listenLocal helper (packages/cli/src/test-util.ts) is the sanctioned way to start a test server.
  - _why:_ Production fixed the bare `server.listen(port)` bind in v3.5 (INV-1) — it silently exposed the unauthenticated build API to the LAN — but nine test call sites (`server.listen(0, r)`) reintroduced the same bind: on Node a missing host binds `::`, every interface. While `npm test` ran on a shared or untrusted network, that API (an `npm install` of a caller-supplied name) was reachable, which is INV-1's exact threat model re-created by the tests that exist to verify INV-1 (finding #30).
  - _enforced by:_ scripts/gate.mjs (inv-33:tests-bind-loopback) + packages/cli/src/v47.test.ts (listenLocal binds 127.0.0.1)

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

<details><summary><b>D-11</b> — safeEqual compares bytes, not digests — and length mismatch answers false</summary>

One helper (core/src/compare.ts) is the only comparison a credential may use. Two design choices are deliberate. (1) It compares the UTF-8 bytes of the two strings rather than hashing both sides to a fixed-width digest first. Digesting would also remove the length question, but it changes what the function means: safeEqual(hashOfKey, storedHash) would be true, so a caller that forgot to hash would silently compare digests and pass the wrong thing. Byte comparison keeps === semantics exactly — the one difference being that a length mismatch answers false instead of throwing. (2) It returns false (never throws) on a length mismatch, because crypto.timingSafeEqual throws RangeError and a throw inside this server exits the process (finding #21). The early return on unequal length does leak the length of the secret, which is acceptable here: every credential is a fixed-width hex hash or a bd_live_ key, and it is the same trade the Node docs make for timingSafeEqual itself. Related asymmetry, recorded because it looks like an inconsistency: operator-side mutations (cloud org add-member/remove-member) still accept either a raw key or a pre-hashed value, because there the caller is the operator; authentication never accepts a pre-hashed value (finding #22).

</details>

<details><summary><b>D-12</b> — A missing manifest stays benign; an unreadable one refuses</summary>

The three-state manifest read (INV-26) draws its line between absence and unreadability on purpose. A site directory with NO .brewdocs.json keeps serving as a public site — that is how hand-dropped directories have always worked, and whoever can delete the manifest can equally rewrite its visibility field, so refusing on absence would buy nothing and break a supported workflow. A manifest that EXISTS but cannot be read or parsed is a different state: the file's real contents are unknown, not 'public', and the most likely cause is the partial-write class the deploy path creates (plain non-atomic writeFileSync in deploySite and setDraftExpiry). That state refuses (500) everywhere and is surfaced on stderr and in /api/sites. The same rule is applied to the key store (INV-29): absence of .keys.json means no keys configured, but an existing store that does not parse means auth IS configured and cannot be verified, so every gated route refuses rather than opening. One asymmetry worth knowing: the CLI could in principle make the writes atomic (write-temp-then-rename), which would shrink the window that creates these states — that is a possible future hardening, not a substitute for failing closed, because the states are reachable by other means (disk corruption, hand-edits, restores) and the read side must not be the only thing standing between a damaged file and an open site.

</details>

<details><summary><b>D-13</b> — An oversized body is refused with a 413 that is written BEFORE the socket closes</summary>

readBody answers 413 for a body over 1 MiB, but the order of operations is load-bearing: write the response, then drain the refused remainder for a bounded deadline (1s), and only then destroy the request. The obvious-looking alternative — `req.destroy()` immediately at refusal — was tested by execution and is wrong: destroying the request races the response write, and a socket closed with unread bytes still queued makes the kernel send RST, so the client sees ECONNRESET and never reads the 413 at all (verified against fetch, a raw chunked writer, and a slow dribble client). Never destroying is also wrong: an endless chunked body would pin the connection until the client gives up, which is a slow-loris the cap was supposed to prevent. The bounded drain is the middle: a well-behaved client reads the 413 and goes away, a hostile endless body gets its socket destroyed when the deadline fires, and memory stays capped either way because the refused bytes are drained, not accumulated. Do not 'simplify' this into an immediate destroy.

</details>

## Findings

Severity and the write-up are human judgement. **Status is not**: every entry marked `fixed` names the check that proves it, and `npm run gate` fails if that check stops passing. Reproduce the whole table with `npm run gate`.

**31 fixed / 0 open** — 0 of the not-yet-fixed ones are high or med-high.

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
| 20 | low | Credentials were compared with === (not constant-time) | fixed | `inv-23:credentials-compared-in-constant-time` |
| 21 | high | One malformed request could kill the process (async handler throw) | fixed | `inv-24:request-cannot-kill-the-process` |
| 22 | medium | A stored API-key hash authenticated as a credential (pass-the-hash) | fixed | `inv-25:stored-hash-is-not-a-credential` |
| 23 | medium | A damaged site manifest silently published a private site | fixed | `inv-26:damaged-manifest-fails-closed` |
| 24 | medium | ?site= walked outside the hosting dir on /mcp and /dashboard | fixed | `inv-27:site-param-cannot-leave-hosting` |
| 25 | high | A private site with no tokenHash served anonymously (private: true config minted no token) | fixed | `inv-28:private-site-always-token-gated` |
| 26 | high | An unreadable key store turned every gated endpoint public | fixed | `inv-29:unreadable-key-store-refuses` |
| 27 | medium | A theme manifest could end the <style> element and inject script into the page | fixed | `inv-30:style-channel-cannot-break-out` |
| 28 | medium | No request-body size limit on any POST route | fixed | `inv-31:post-bodies-are-capped` |
| 29 | medium | BREWDOCS_RATE_LIMIT= (set but empty) silently disabled the server | fixed | `inv-32:env-numeric-options-validated` |
| 30 | medium | The test suite bound every interface while serving the unauthenticated build API | fixed | `inv-33:tests-bind-loopback` |
| 31 | low | The trust-boundary table in the generated map rendered empty from v4.5.1 through v4.6 | fixed | `map:trust-table-populated` |

## Working in this repo

**Pipeline.** `Source → extractFromSource → ExtractResult → buildModel → RenderModel → renderToHtml`. Everything else (deploy, markdown export, audit, drift) is a consumer of that chain.

**Conventions.** ESM with `node:`-prefixed imports and `.js` extensions in specifiers (required for ESM resolution under tsx/vitest). Tests import the workspace via the `@brewdocs/core` alias; fixtures go in `fs.mkdtempSync(os.tmpdir())`; describe titles carry version tags (`"v2.0 …"`).

**Errors degrade, they do not crash.** A bad symbol, plugin or adapter warns and is skipped. The build is expected to produce a page even from messy input — preserve that.

**Adding a top-level core module** needs no `files` allowlist edit (the allowlist is `dist`, wholesale) — but always `npm pack --dry-run` before a release. A stale allowlist once shipped a 3.0.0 with 19 missing modules.

**Commands.** `npm test` · `npm run typecheck` · `npx vitest run <path>` · `npx vitest run <path> -t "name"` · `npm run brewdocs -- build ./docs --theme ink --out docs-site`. Full suite takes a few minutes; the examples suite alone is ~30s.

**When you change a trust boundary**, update `docs/map/facts/invariants.json` in the same commit and run `npm run map`. The gate executes each finding's `verify` command, so an entry marked `fixed` that regresses turns the build red instead of going quiet.
