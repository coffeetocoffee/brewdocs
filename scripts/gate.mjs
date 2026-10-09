#!/usr/bin/env node
/**
 * SECURITY GATE
 * =============
 *   node scripts/gate.mjs          # run every check
 *   node scripts/gate.mjs --json   # machine-readable
 *
 * Checks the invariants that already shipped broken once. Three kinds:
 *
 *   1. DRIFT  — the committed project map matches what the generator produces.
 *   2. STATIC — structural facts asserted directly from the source (bind
 *               address, --ignore-scripts, escape helper coverage, containment
 *               style). Cheap, no test run needed.
 *   3. VERIFY — each finding in facts/findings.json marked `fixed` names a
 *               command; run it. A finding that regresses turns the build red
 *               instead of quietly going stale in a markdown table.
 *
 * This is deliberately narrow. It does not try to lint the codebase or measure
 * coverage; it protects the handful of properties whose failure mode is a
 * security bug rather than an ugly output.
 */

import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (p) => fs.readFileSync(path.join(ROOT, p), "utf8");
const asJson = process.argv.includes("--json");

const results = [];
const pass = (name, detail = "") => results.push({ name, ok: true, detail });
const fail = (name, detail) => results.push({ name, ok: false, detail });

/* ------------------------------------------------------- 1. map drift */

function checkMapDrift() {
  try {
    execFileSync(process.execPath, ["scripts/map.mjs", "--check"], {
      cwd: ROOT,
      stdio: "pipe",
    });
    pass("map:up-to-date");
  } catch (e) {
    fail("map:up-to-date", "docs/map is stale — run `npm run map`");
  }
}

/* ------------------------------------------------- 2. static invariants */

function checkBindDefault() {
  const src = read("packages/cli/src/index.ts");
  const hasExplicit = /server\.listen\(port,\s*host/.test(src);
  const hasLoopback = /BREWDOCS_HOST\s*\?\?\s*"127\.0\.0\.1"/.test(src);
  if (hasExplicit && hasLoopback) pass("inv-1:serve-binds-loopback");
  else
    fail(
      "inv-1:serve-binds-loopback",
      `explicit listen(port, host)=${hasExplicit}, loopback default=${hasLoopback}`,
    );
}

function checkIgnoreScripts() {
  const src = read("packages/core/src/resolve.ts");
  // The install must disable lifecycle scripts.
  const ok = /runNpm\(\[\s*"install"[\s\S]{0,200}?"--ignore-scripts"/.test(src);
  if (ok) pass("inv-2:npm-ignore-scripts");
  else fail("inv-2:npm-ignore-scripts", "npm install no longer passes --ignore-scripts");
}

function checkSourceConfinement() {
  const src = read("packages/cli/src/server.ts");
  const hasGuard = /function resolveServerSource/.test(src);
  const has403 = /403/.test(src);
  const usedByBuild = /guardSource\(data\.source/.test(src);
  if (hasGuard && has403 && usedByBuild) pass("inv-3:source-confinement");
  else
    fail(
      "inv-3:source-confinement",
      `resolveServerSource=${hasGuard}, 403=${has403}, wired=${usedByBuild}`,
    );
}

/** Every non-test TypeScript file under the packages' src/ trees. */
function sourceFiles() {
  const out = [];
  const walk = (rel) => {
    for (const e of fs.readdirSync(path.join(ROOT, rel), { withFileTypes: true })) {
      const child = `${rel}/${e.name}`;
      if (e.isDirectory()) {
        if (e.name !== "__snapshots__") walk(child);
      } else if (e.name.endsWith(".ts") && !e.name.endsWith(".test.ts")) {
        out.push(child);
      }
    }
  };
  for (const d of ["packages/core/src", "packages/cli/src"]) {
    if (fs.existsSync(path.join(ROOT, d))) walk(d);
  }
  return out;
}

/**
 * INV-4: every HTML escaper must handle quotes, and the canonical one lives in
 * packages/core/src/escape.ts. Scanning the whole tree — not a fixed file list —
 * is the point: local escapers in highlight/workspaces/registry/federation used
 * to escape only `&<>`, invisible to the old check. A quote-blind helper is
 * exactly how the attribute-injection XSS shipped.
 */
function checkEscapeHelpers() {
  const canonical = "packages/core/src/escape.ts";
  if (!fs.existsSync(path.join(ROOT, canonical))) {
    return fail("inv-4:escape-helpers-quote-safe", `${canonical} is missing`);
  }
  const isEscaperName = (n) => /^esc(ape)?/i.test(n) || /escape/i.test(n);
  const defRe =
    /(?:function\s+(\w+)\s*\([^)]*\)\s*\{|(?:const|let|var)\s+(\w+)\s*=\s*(?:\([^)]*\)|\w+)\s*=>)/g;
  const offenders = [];
  for (const f of sourceFiles()) {
    const src = read(f);
    for (const m of src.matchAll(defRe)) {
      const name = m[1] || m[2] || "";
      if (!isEscaperName(name)) continue;
      const body = src.slice(m.index, m.index + 700);
      if (!/&lt;/.test(body)) continue; // not an HTML escaper (e.g. escapeRegExp)
      if (!/&quot;|&#39;|&apos;/.test(body)) offenders.push(`${f}:${name}`);
    }
  }
  if (offenders.length === 0) pass("inv-4:escape-helpers-quote-safe");
  else
    fail(
      "inv-4:escape-helpers-quote-safe",
      `escape helper(s) escape < but not quotes: ${offenders.join(", ")}`,
    );
}

/**
 * INV-19: every write endpoint must carry an explicit guard before it can act
 * on caller input. A new POST route that forgets authorize() would otherwise
 * ship as an open write surface. Write APIs require authorize() (and guardSource
 * for local paths); the /mcp RPC query route is specifically validated for
 * read authorization, manifest containment and site token gating.
 */
function checkWriteEndpointsGuarded() {
  const lines = read("packages/cli/src/server.ts").split("\n");
  const offenders = [];
  for (let i = 0; i < lines.length; i++) {
    const route = /url\.pathname === "([^"]+)"/.exec(lines[i]);
    if (!route) continue;
    let end = i + 1;
    while (end < lines.length && !/url\.pathname === "/.test(lines[end])) end++;
    const block = lines.slice(i, end).join("\n");
    if (!/req\.method === "POST"/.test(block)) continue;
    const pathname = route[1];
    if (pathname === "/mcp") {
      // MCP is an RPC query transport over POST: must check read auth and site access
      if (!/authorizeRead\(/.test(block) || !/requireSiteAccess\(/.test(block) || !/readManifest\(/.test(block)) {
        offenders.push(`${pathname} (missing read/site-access guards)`);
      }
    } else {
      // True mutation/write endpoints must require scope authorization
      if (!/authorize\(/.test(block)) {
        offenders.push(`${pathname} (missing authorize scope guard)`);
      } else if (/parseSource\(/.test(block) && !/guardSource\(/.test(block)) {
        offenders.push(`${pathname} (missing guardSource path confinement)`);
      }
    }
  }
  if (offenders.length === 0) pass("inv-19:write-endpoints-guarded");
  else
    fail(
      "inv-19:write-endpoints-guarded",
      `write endpoint(s) with no guard: ${offenders.join(", ")}`,
    );
}

function checkBoundaryContainment() {
  const src = read("packages/cli/src/server.ts");
  // A bare `startsWith(base)` with no separator is the INV-5 pattern.
  const bad = /startsWith\(base\)/.test(src);
  const good = /startsWith\(base \+ path\.sep\)/.test(src);
  if (good && !bad) pass("inv-5:boundary-aware-containment");
  else
    fail(
      "inv-5:boundary-aware-containment",
      `separator-aware=${good}, bare-startsWith(base)=${bad}`,
    );
}

function checkSubdomainValidation() {
  const src = read("packages/cli/src/server.ts");
  const v46TestSrc = read("packages/cli/src/v46.test.ts");
  // The slug guard must exist AND be applied across routing and query parameters.
  const hasRe = /SAFE_SUBDOMAIN\s*=/.test(src);
  const appliedResolveSite = /SAFE_SUBDOMAIN\.test\(sub\)/.test(src);
  const appliedReadManifest = /SAFE_SUBDOMAIN\.test\(subdomain\)/.test(src);
  const appliedStats = /SAFE_SUBDOMAIN\.test\(site\)/.test(src);
  // Behavioral test checks: ?site= traversal refused on dashboard, stats, and mcp
  const hasBehavioralTests =
    v46TestSrc.includes("/dashboard?site=") &&
    v46TestSrc.includes("/api/stats?site=") &&
    v46TestSrc.includes("/mcp?site=");

  if (hasRe && appliedResolveSite && appliedReadManifest && appliedStats && hasBehavioralTests) {
    pass("inv-6:subdomain-slug-guard");
  } else {
    fail(
      "inv-6:subdomain-slug-guard",
      `regex=${hasRe}, resolveSite=${appliedResolveSite}, readManifest=${appliedReadManifest}, stats=${appliedStats}, tests=${hasBehavioralTests}`,
    );
  }
}

function checkUrlSchemeValidation() {
  const src = read("packages/core/src/escape.ts");
  const hasSafeUrl = /export function safeUrl/.test(src);
  const blocks = /javascript\|vbscript\|data/.test(src);
  const stripsControl = /\\u0000-\\u001f/.test(src);
  if (hasSafeUrl && blocks && stripsControl) pass("inv-7:url-scheme-validation");
  else
    fail(
      "inv-7:url-scheme-validation",
      `safeUrl=${hasSafeUrl}, blocksScriptSchemes=${blocks}, stripsControlChars=${stripsControl}`,
    );
}

/**
 * INV-8: writers that take a site-root-relative path from config must confine
 * it to the output directory. `redirects:`/`aliases:` come from brewdocs.yml in
 * a repo you may not own.
 */
function checkOutputContainment() {
  const src = read("packages/core/src/aliases.ts");
  const hasHelper = /export function resolveInOutDir/.test(src);
  const boundary = /startsWith\(root \+ path\.sep\)/.test(src);
  const usedByRedirects = /resolveInOutDir\(outDir, from\)/.test(src);
  if (hasHelper && boundary && usedByRedirects) pass("inv-8:output-dir-containment");
  else
    fail(
      "inv-8:output-dir-containment",
      `resolveInOutDir=${hasHelper}, boundaryAware=${boundary}, usedByRedirects=${usedByRedirects}`,
    );
}

/** INV-9: theme slot partials must be confined to the manifest's source root. */
function checkSlotConfinement() {
  const src = read("packages/core/src/theme-manifest.ts");
  const hasRoot = /manifest\.sourceRoot/.test(src);
  const boundary = /file\.startsWith\(root \+ path\.sep\)/.test(src);
  const setOnLoad = /manifest\.sourceRoot = sourceRoot/.test(src);
  if (hasRoot && boundary && setOnLoad) pass("inv-9:theme-slot-confinement");
  else
    fail(
      "inv-9:theme-slot-confinement",
      `usesSourceRoot=${hasRoot}, boundaryAware=${boundary}, setOnLoad=${setOnLoad}`,
    );
}

/**
 * INV-11: CI workflows install with `npm ci`, never `npm install`. A
 * lockfile-ignoring install on a tree that contains package.json scripts is a
 * supply-chain surface (finding #13).
 */
function checkCiWorkflows() {
  const dir = path.join(ROOT, ".github", "workflows");
  if (!fs.existsSync(dir)) return pass("inv-11:ci-uses-npm-ci");
  const offenders = fs
    .readdirSync(dir)
    .filter((f) => /\.ya?ml$/.test(f))
    .filter((f) => /\bnpm\s+install\b/.test(read(path.join(".github", "workflows", f))));
  if (offenders.length === 0) pass("inv-11:ci-uses-npm-ci");
  else fail("inv-11:ci-uses-npm-ci", `workflow(s) use npm install: ${offenders.join(", ")}`);
}

/**
 * INV-12: the published core must resolve to compiled JS, not raw TypeScript,
 * so `import "@brewdocs/core"` works under plain Node (finding #8).
 */
function checkCorePackaging() {
  let pkg;
  try {
    pkg = JSON.parse(read("packages/core/package.json"));
  } catch {
    return fail("inv-12:core-ships-compiled", "packages/core/package.json unreadable");
  }
  const root = pkg.exports?.["."];
  const ok =
    pkg.main === "./dist/index.js" &&
    pkg.types === "./dist/index.d.ts" &&
    root &&
    root.types === "./dist/index.d.ts" &&
    root.import === "./dist/index.js" &&
    Array.isArray(pkg.files) &&
    pkg.files.includes("dist");
  if (ok) pass("inv-12:core-ships-compiled");
  else
    fail(
      "inv-12:core-ships-compiled",
      "core must export ./dist/index.js + .d.ts and list dist in files",
    );
}

/** INV-13: a per-user key's scopes must gate each write endpoint (finding #9). */
function checkKeyScopes() {
  const src = read("packages/cli/src/server.ts");
  const scopeCheck = /scopes\.includes\(scope\)/.test(src);
  const build = /authorize\(req, "build"\)/.test(src);
  const exp = /authorize\(req, "export"\)/.test(src);
  const md = /authorize\(req, "markdown"\)/.test(src);
  if (scopeCheck && build && exp && md) pass("inv-13:key-scopes-enforced");
  else
    fail(
      "inv-13:key-scopes-enforced",
      `scopeCheck=${scopeCheck}, build=${build}, export=${exp}, markdown=${md}`,
    );
}

/** INV-14: publishing must run the verify gate first (finding #7). */
function checkReleaseVerify() {
  const src = read(".github/workflows/publish.yml");
  if (/npm run verify/.test(src) || /npm run typecheck/.test(src))
    pass("inv-14:release-runs-verify");
  else
    fail(
      "inv-14:release-runs-verify",
      "publish.yml runs neither `npm run verify` nor `npm run typecheck` before publishing",
    );
}

/**
 * INV-15: X-Forwarded-For is only honoured behind an explicit opt-in; the
 * default client key is the socket address (finding #10).
 */
function checkTrustProxy() {
  const src = read("packages/cli/src/server.ts");
  const gated = /trustProxy/.test(src);
  const offByDefault = /BREWDOCS_TRUST_PROXY === "1"/.test(src);
  if (gated && offByDefault) pass("inv-15:trust-proxy-opt-in");
  else
    fail(
      "inv-15:trust-proxy-opt-in",
      `trustProxy=${gated}, envOptIn=${offByDefault}`,
    );
}

/** INV-16: read endpoints must be gated once auth is configured (finding #11). */
function checkReadGuards() {
  const src = read("packages/cli/src/server.ts");
  const hasHelper = /function authorizeRead|const authorizeRead/.test(src);
  const sites = /\/api\/sites[\s\S]{0,120}?authorizeRead\(req\)/.test(src);
  const registry = /\/api\/registry[\s\S]{0,160}?authorizeRead\(req\)/.test(src);
  const search = /\/api\/search[\s\S]{0,120}?authorizeRead\(req\)/.test(src);
  if (hasHelper && sites && registry && search) pass("inv-16:read-endpoints-guarded");
  else
    fail(
      "inv-16:read-endpoints-guarded",
      `helper=${hasHelper}, sites=${sites}, registry=${registry}, search=${search}`,
    );
}

/** INV-17: the python adapter must refuse a fetched source (finding #15). */
function checkPythonFetchedGuard() {
  const src = read("packages/core/src/extractors/python.ts");
  if (/if \(ctx\.fetched\)/.test(src)) pass("inv-17:python-refuses-fetched");
  else fail("inv-17:python-refuses-fetched", "python adapter no longer checks ctx.fetched");
}

/**
 * INV-20: a plugin is arbitrary code, and its specifier is read from the
 * source's own brewdocs.yml. A fetched (npm/git) source must not get to choose
 * code that runs on the operator's machine (finding #19).
 *
 * The interesting failure mode here is propagation, not the guard itself.
 * `fetched` has to survive every hop between resolveInput and resolveSetup, and
 * each hop that rebuilt a Source without it silently re-enabled the repo's
 * plugins — which is exactly how the first version of this fix was bypassed
 * three times. So this asserts the guard *and* every re-construction site.
 */
function checkPluginFetchedGuard() {
  const buildSrc = read("packages/core/src/build.ts");
  const cliSrc = read("packages/cli/src/index.ts");
  const testSrc = read("packages/core/test/plugin-fetched.test.ts");

  // The guard itself: repo-config plugins are dropped when source.fetched...
  const guarded = /if \(source\.fetched && configPlugins\.length > 0\)/.test(buildSrc);
  // ...and the drop is announced, not silent.
  const warns = /cannot choose code that runs on your machine/.test(buildSrc);

  // Every place a Source is rebuilt for a per-version worktree, or handed to
  // build() from the CLI, must carry `fetched` through.
  const versioned = (
    buildSrc.match(/root: srcRoot, name: source\.name, fetched: source\.fetched/g) ?? []
  ).length;
  // Fallback rebuild in buildVersions when tag checkout fails must also carry fetched.
  const fallbackRebuild = /root,\s*name:\s*source\.name,\s*fetched:\s*source\.fetched/.test(buildSrc);
  const cliPropagates = /fetched: resolved\.source\.fetched/.test(cliSrc);
  const testCoversFallback = /preserves fetched: true in buildVersions fallback/.test(testSrc);

  if (guarded && warns && versioned >= 3 && fallbackRebuild && cliPropagates && testCoversFallback)
    pass("inv-20:fetched-source-cannot-name-plugins");
  else
    fail(
      "inv-20:fetched-source-cannot-name-plugins",
      `guard=${guarded}, warns=${warns}, versionedRebuilds=${versioned}/3, fallback=${fallbackRebuild}, cliPropagates=${cliPropagates}, testCoversFallback=${testCoversFallback}`,
    );
}

/** INV-18: the renderer has a golden-output snapshot (finding #17). */
function checkRendererGolden() {
  const test = path.join(ROOT, "packages", "core", "test", "render.golden.test.ts");
  const snap = path.join(ROOT, "packages", "core", "test", "__snapshots__", "render.golden.test.ts.snap");
  if (fs.existsSync(test) && fs.existsSync(snap)) pass("inv-18:renderer-golden");
  else fail("inv-18:renderer-golden", "renderer golden test or its snapshot is missing");
}

/**
 * INV-21: the HTTP MCP transport must be gated exactly like the other reads —
 * an unauthenticated caller on a server with auth configured must not query a
 * site's docmodel, and a private site needs its access token. It must also
 * record what it was asked, or the whole point of the endpoint (closing the
 * feedback loop) is lost. Asserted from the parsed route block, so moving the
 * guard out of the block is caught rather than a token merely existing.
 */
function checkMcpHttpGuarded() {
  const lines = read("packages/cli/src/server.ts").split("\n");
  const start = lines.findIndex((l) => /url\.pathname === "\/mcp"/.test(l));
  if (start < 0) return fail("inv-21:mcp-http-guarded", "no /mcp route in server.ts");
  let end = start + 1;
  while (end < lines.length && !/url\.pathname === "/.test(lines[end])) end++;
  const block = lines.slice(start, end).join("\n");

  const isPost = /req\.method === "POST"/.test(block);
  const readGuard = /authorizeRead\(req\)/.test(block);
  const privateGuard = /requireSiteAccess\(/.test(block);
  const telemetry = /recordToolCall\(/.test(block);
  if (isPost && readGuard && privateGuard && telemetry)
    pass("inv-21:mcp-http-guarded");
  else
    fail(
      "inv-21:mcp-http-guarded",
      `POST=${isPost}, authorizeRead=${readGuard}, requireSiteAccess=${privateGuard}, recordToolCall=${telemetry}`,
    );
}

/**
 * INV-22: stdio and HTTP must speak one protocol. Both transports route through
 * `handleMcpMessage`, so a change to tool dispatch cannot land in only one of
 * them — the class of bug that made the plugin `fetched` guard fail three times.
 */
function checkMcpSharedHandler() {
  const src = read("packages/core/src/mcp.ts");
  const exported = /export function handleMcpMessage/.test(src);
  const stdioUses = /runMcpServer[\s\S]{0,1400}?handleMcpMessage\(/.test(src);
  const httpUses = /handleMcpRequest[\s\S]{0,900}?handleMcpMessage\(/.test(src);
  if (exported && stdioUses && httpUses) pass("inv-22:mcp-one-protocol-handler");
  else
    fail(
      "inv-22:mcp-one-protocol-handler",
      `exported=${exported}, stdioUses=${stdioUses}, httpUses=${httpUses}`,
    );
}

/**
 * INV-23: every comparison against a credential must go through `safeEqual`
 * (finding #20). A `===` on a secret is not constant-time, and the credential
 * sites are spread across four modules — the same "one fix, many copies"
 * shape as the escaping bug (INV-4), so this scans every source file rather
 * than a fixed list. The scan is deliberately textual: a secret-ish identifier
 * on either side of `===`/`!==` is the pattern that shipped, and the fix is
 * always to route it through safeEqual.
 */
function checkCredentialComparison() {
  const compareSrc = "packages/core/src/compare.ts";
  if (!fs.existsSync(path.join(ROOT, compareSrc))) {
    return fail("inv-23:credentials-compared-in-constant-time", `${compareSrc} is missing`);
  }
  if (!/export function safeEqual\(/.test(read(compareSrc))) {
    return fail("inv-23:credentials-compared-in-constant-time", "safeEqual is not exported");
  }
  // It must never throw on a length mismatch: crypto.timingSafeEqual does, and
  // in this server that throw exits the process (finding #21).
  if (!/length !== right\.length\) return false/.test(read(compareSrc))) {
    return fail(
      "inv-23:credentials-compared-in-constant-time",
      "safeEqual does not guard the length mismatch",
    );
  }

  // Leading word boundary only: `operatorToken` has none before "Token".
  const secretish = /\b(token|secret|credential|apikey|api_key|keyhash|hash|passw)/i;
  const ident = String.raw`[A-Za-z_$][\w$.]*(?:\[[^\]]*\])?(?:\([^()]*\))?`;
  const lit = String.raw`"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|\`(?:[^\`\\]|\\.)*\``;
  const op = `(?:${ident}|${lit})`;
  const cmp = new RegExp(`(${op})\\s*(===|!==)\\s*(${op})`, "g");
  const offenders = [];
  for (const f of sourceFiles()) {
    const lines = read(f).split("\n");
    lines.forEach((line, i) => {
      const trimmed = line.trim();
      if (trimmed.startsWith("//") || trimmed.startsWith("*") || trimmed.startsWith("/*")) return;
      cmp.lastIndex = 0;
      let m;
      while ((m = cmp.exec(line)) !== null) {
        const before = line.slice(0, m.index);
        if (before.includes("//")) continue;
        if (/\btypeof\s+$/.test(before)) continue;
        if (/^(undefined|null|true|false)$/.test(m[1]) || /^(undefined|null|true|false)$/.test(m[3])) {
          continue;
        }
        if (secretish.test(m[1]) || secretish.test(m[3])) {
          offenders.push(`${f}:${i + 1} (${m[1]} ${m[2]} ${m[3]})`);
        }
      }
    });
  }
  if (offenders.length === 0) pass("inv-23:credentials-compared-in-constant-time");
  else
    fail(
      "inv-23:credentials-compared-in-constant-time",
      `credential comparison(s) outside safeEqual: ${offenders.join(", ")}`,
    );
}

/**
 * INV-24: one bad request must not be able to kill the process (finding #21).
 * An async request listener that throws rejects a promise with no handler
 * attached, and Node exits; a synchronous throw in a listener does the same;
 * an unhandled 'error' on a read stream does the same. Requests are untrusted
 * input, so each of the three server surfaces needs its guard, and the gate
 * asserts them structurally rather than by running a server.
 */
function checkRequestSurvival() {
  const serverSrc = read("packages/cli/src/server.ts");
  const cliSrc = read("packages/cli/src/index.ts");

  // The shared handler is wrapped in a try/catch, and the URL parse has its own
  // 400 (a caller-controlled request line that is not a URL).
  const wrapped = /try \{\s*\n\s*await handle\(req, res\);\s*\n\s*\} catch/.test(serverSrc);
  const urlGuarded = /let url: URL;\s*\n\s*try \{\s*\n\s*url = new URL\(req\.url/.test(serverSrc);
  // The preview server guards both the URL parse and the percent-decode.
  const previewGuarded = /rel = decodeURIComponent\(url\.pathname\);\s*\n\s*\} catch/.test(cliSrc);
  // Both static file streams handle 'error' instead of crashing on a file that
  // vanished between the existence check and the open.
  const streamGuards =
    (serverSrc.match(/stream\.on\("error"/g) ?? []).length +
    (cliSrc.match(/stream\.on\("error"/g) ?? []).length;

  if (wrapped && urlGuarded && previewGuarded && streamGuards >= 2)
    pass("inv-24:request-cannot-kill-the-process");
  else
    fail(
      "inv-24:request-cannot-kill-the-process",
      `wrapped=${wrapped}, urlGuarded=${urlGuarded}, previewGuarded=${previewGuarded}, streamGuards=${streamGuards}/2`,
    );
}

/**
 * INV-25: a stored credential hash must not itself authenticate (finding #22).
 * `canAccessOrg` used `normalizeKeyHash`, which passes a non-`bd_live_` string
 * through untouched — right for `add-member` (the operator may paste a hash),
 * wrong for authentication, where it made every readable `.cloud.json` a bag of
 * usable credentials. The two key stores disagreed: `validateKey` always
 * hashes, so the hash double-hashes and misses. This asserts the auth path
 * hashes and the mutation paths keep their convenience.
 */
function checkStoredHashNotACredential() {
  const cloudSrc = read("packages/core/src/cloud.ts");
  const authUsesHash = /const keyHash = hashKey\(presented\);/.test(cloudSrc);
  const authDoesNotNormalize = !/const keyHash = normalizeKeyHash\(presented\);/.test(cloudSrc);
  // add-member / remove-member still accept either form from the operator.
  const mutationKeeps = /normalizeKeyHash\(keyOrHash\)/.test(cloudSrc);
  if (authUsesHash && authDoesNotNormalize && mutationKeeps)
    pass("inv-25:stored-hash-is-not-a-credential");
  else
    fail(
      "inv-25:stored-hash-is-not-a-credential",
      `authHashes=${authUsesHash}, authAvoidsNormalize=${authDoesNotNormalize}, mutationKeeps=${mutationKeeps}`,
    );
}

/**
 * INV-26: a site manifest that exists but cannot be read must fail CLOSED
 * (finding #23). `readManifest` answers three states; absence stays benign
 * (D-12), but `unreadable` must refuse everywhere — a truncated manifest used
 * to read as "no tokenHash", and `requireSiteAccess` reads an absent tokenHash
 * as public, so a damaged file silently published a private site.
 */
function checkManifestFailClosed() {
  const src = read("packages/cli/src/server.ts");
  const threeState =
    /state: "ok"/.test(src) &&
    /state: "missing"/.test(src) &&
    /state: "unreadable"/.test(src);
  // Only ENOENT may degrade to "missing": a permissions or I/O error is not
  // the benign case and must not open the site either.
  const enoentOnly = /code === "ENOENT"\) return \{ state: "missing" \}/.test(src);
  // Both parse failures — invalid JSON and a non-object document — must land
  // in `unreadable`. Asserting the returns, not the string's existence: a
  // catch that answers "ok" with an empty manifest would still contain the
  // word "unreadable" in the type union and pass a shallower check.
  const parseFailClosed = /catch \{\s*\n\s*return unreadable\("invalid JSON"\);/.test(src);
  const nonObjectFailClosed = /return unreadable\("not a JSON object"\);/.test(src);
  // The site serve path, /mcp, /dashboard and /api/stats each refuse.
  const refusals = (src.match(/if \(read\.state === "unreadable"\)/g) ?? []).length;
  // /api/sites must not advertise an unreadable site as public.
  const listedAsPrivate = /read\.state === "unreadable" \? "private"/.test(src);
  if (threeState && enoentOnly && parseFailClosed && nonObjectFailClosed && refusals >= 4 && listedAsPrivate)
    pass("inv-26:damaged-manifest-fails-closed");
  else
    fail(
      "inv-26:damaged-manifest-fails-closed",
      `threeState=${threeState}, enoentOnly=${enoentOnly}, parseFailClosed=${parseFailClosed}, nonObjectFailClosed=${nonObjectFailClosed}, refusals=${refusals}/4, listedAsPrivate=${listedAsPrivate}`,
    );
}

/**
 * INV-27: the subdomain taken from `?site=` must be validated before any
 * filesystem access (finding #24). /s/ and Host routing validate in
 * resolveSite; the query-param routes all read the manifest first, so
 * `readManifest` is the chokepoint — and /mcp must build its docmodel path
 * only after that read, never from the raw parameter.
 */
function checkSiteParamContainment() {
  const src = read("packages/cli/src/server.ts");
  // The chokepoint itself: a non-slug name answers "missing", never a path.
  const slugGate =
    /if \(!SAFE_SUBDOMAIN\.test\(subdomain\)\) return \{ state: "missing" \};/.test(src);

  const lines = src.split("\n");
  const start = lines.findIndex((l) => /url\.pathname === "\/mcp"/.test(l));
  if (start < 0) return fail("inv-27:site-param-cannot-leave-hosting", "no /mcp route");
  let end = start + 1;
  while (end < lines.length && !/url\.pathname === "/.test(lines[end])) end++;
  const block = lines.slice(start, end).join("\n");
  const readsFirst =
    block.indexOf("readManifest(") >= 0 &&
    block.indexOf("readManifest(") < block.indexOf("docmodel.json");
  const refusesMissing = /state === "missing"[\s\S]{0,300}?404/.test(block);

  if (slugGate && readsFirst && refusesMissing)
    pass("inv-27:site-param-cannot-leave-hosting");
  else
    fail(
      "inv-27:site-param-cannot-leave-hosting",
      `slugGate=${slugGate}, mcpReadsManifestFirst=${readsFirst}, refusesMissing=${refusesMissing}`,
    );
}

/**
 * INV-28: a private site is always token-gated (finding #25). Two halves, and
 * both are needed: the CLI must mint a token for every private deploy (the
 * `private: true` config path used to mint none), and the server must refuse a
 * private manifest that has no tokenHash instead of reading "no hash" as
 * public — the backstop for hand-edited or pre-fix manifests.
 */
function checkPrivateAlwaysGated() {
  const serverSrc = read("packages/cli/src/server.ts");
  const cliSrc = read("packages/cli/src/index.ts");
  const refuses = /!tokenHash && manifest\?\.visibility !== "private"/.test(serverSrc);
  const mints = /visibility === "private"[\s\S]{0,80}?crypto\.randomBytes/.test(cliSrc);
  if (refuses && mints) pass("inv-28:private-site-always-token-gated");
  else
    fail(
      "inv-28:private-site-always-token-gated",
      `serverRefusesHashlessPrivate=${refuses}, cliMintsForEveryPrivate=${mints}`,
    );
}

/**
 * INV-29: an unreadable key store must count as "auth IS configured"
 * (finding #26). `loadKeys` answers [] for every failure, so a damaged
 * .keys.json would otherwise read as "no keys configured" and every gated
 * route would answer anonymously.
 *
 * v4.8: the state is now read per request (finding #33 / INV-35), so the
 * assertions are on keyStoreState's three-way distinction and on
 * keysConfigured treating `unreadable` as configured — not on the old
 * `needsAuth = ... || keysUnreadable || ...` one-liner, which no longer exists.
 */
function checkKeyStoreFailClosed() {
  const keysSrc = read("packages/cli/src/keys.ts");
  const helper = /export function keysStoreUnreadable/.test(keysSrc);
  const stateHelper = /export function keyStoreState\(/.test(keysSrc);
  // A store that parses but is not an array is unreadable, not empty.
  const checksArray = /if \(!Array\.isArray\(parsed\)\) return "unreadable";/.test(keysSrc);
  // Unreadable counts as configured: the whole point of the finding.
  const unreadableIsConfigured =
    /return state === "configured" \|\| state === "unreadable";/.test(keysSrc);
  // And the guard actually consults it per request (INV-35 pins the liveness).
  const wired = /const configured = keysConfigured\(hostingDir\);/.test(read("packages/cli/src/server.ts"));
  if (helper && stateHelper && checksArray && unreadableIsConfigured && wired) {
    pass("inv-29:unreadable-key-store-refuses");
  } else {
    fail(
      "inv-29:unreadable-key-store-refuses",
      `helper=${helper}, stateHelper=${stateHelper}, checksArray=${checksArray}, ` +
        `unreadableIsConfigured=${unreadableIsConfigured}, wired=${wired}`,
    );
  }
}

/**
 * INV-30: theme CSS text must not close the raw-text <style> element
 * (finding #27). Vars come from manifests and plugins, and the css blob from
 * a manifest; all three pass through cssSafe, which neutralizes `<`.
 */
function checkStyleChannelBreakout() {
  const src = read("packages/core/src/render.ts");
  const helper = /function cssSafe\(/.test(src) && src.includes("\\3c");
  const varsK = /cssSafe\(k\)/.test(src);
  const varsV = /cssSafe\(v\)/.test(src);
  const css = /cssSafe\(theme\.css\)/.test(src);
  if (helper && varsK && varsV && css) pass("inv-30:style-channel-cannot-break-out");
  else
    fail(
      "inv-30:style-channel-cannot-break-out",
      `helper=${helper}, varsK=${varsK}, varsV=${varsV}, css=${css}`,
    );
}

/**
 * INV-31: every POST route must read its body through the capped reader
 * (finding #28). Four routes each did `body += chunk` with no bound, so one
 * unauthenticated POST could grow the heap until the process died. The cap
 * lives in readBody (content-length pre-check + running byte count + 413);
 * this asserts the helper, its wiring, and that the unbounded pattern is gone.
 */
function checkPostBodyCapped() {
  const src = read("packages/cli/src/server.ts");
  const helper = /async function readBody\(/.test(src);
  const cap = /MAX_BODY_BYTES = 1024 \* 1024/.test(src);
  // Both refusal halves: declared content-length, and the running byte count.
  const preCheck = /declared > maxBytes/.test(src);
  const running = /total > maxBytes/.test(src);
  const refuses = /function refuseTooLarge\(/.test(src) && /writeHead\(413/.test(src);
  // The unbounded read is what regressed; a re-added copy must turn this red.
  const unbounded = /body \+= chunk/.test(src);
  // All four POST routes go through the helpers.
  const wired =
    (src.match(/readJsonBody</g) ?? []).length >= 3 &&
    (src.match(/await readBody\(req, res\)/g) ?? []).length >= 1;
  // The behavior is asserted, not just the shape (v47.test.ts).
  const tested = read("packages/cli/src/v47.test.ts").includes("payload too large");

  if (helper && cap && preCheck && running && refuses && !unbounded && wired && tested)
    pass("inv-31:post-bodies-are-capped");
  else
    fail(
      "inv-31:post-bodies-are-capped",
      `helper=${helper}, cap=${cap}, preCheck=${preCheck}, running=${running}, refuses=${refuses}, unboundedRead=${unbounded}, wired=${wired}, tested=${tested}`,
    );
}

/**
 * INV-32: a numeric env option must be validated, not merely NaN-checked
 * (finding #29). `Number("")` is 0 and `Number("-5")` is -5, so
 * `BREWDOCS_RATE_LIMIT=` (the normal .env shape) read as "limit 0" and
 * bricked the build routes; a negative concurrency pinned the queue forever.
 * Env values below the floor warn and fall back; the embedding API channel
 * keeps 0 legal where it means "no capacity" (the queue-full 503 test).
 */
function checkNumericEnvValidated() {
  const src = read("packages/cli/src/server.ts");
  const floor = /parsed >= opts\.min/.test(src);
  const emptyIsNaN = /env\.trim\(\) === "" \? NaN/.test(src);
  const warns = /console\.warn\(/.test(src) && /is not usable/.test(src);
  // The four call sites carry floors: limit/window/concurrency >= 1, queue >= 0.
  const callSites = (src.match(/numOption\(/g) ?? []).length >= 5; // 1 def + 4 uses
  const mins = (src.match(/min: 1,\s*\n\s*name: "BREWDOCS_/g) ?? []).length >= 3;
  // The behavior is asserted, not just the shape (v47.test.ts).
  const tested = read("packages/cli/src/v47.test.ts").includes("BREWDOCS_RATE_LIMIT=");

  if (floor && emptyIsNaN && warns && callSites && mins && tested)
    pass("inv-32:env-numeric-options-validated");
  else
    fail(
      "inv-32:env-numeric-options-validated",
      `floor=${floor}, emptyIsNaN=${emptyIsNaN}, warns=${warns}, callSites=${callSites}, mins=${mins}, tested=${tested}`,
    );
}

/**
 * INV-33: no test may bind every interface (finding #30). Production fixed
 * the bare `server.listen(port)` bind in v3.5 (INV-1), and nine test call
 * sites reintroduced it: a bare `listen(0)` binds `::`, so while `npm test`
 * ran on a shared network the unauthenticated build API was LAN-reachable.
 * Every `.listen(` in a *.test.ts must name 127.0.0.1, and the shared helper
 * (test-util.ts) is the sanctioned way to start a test server.
 */
function checkTestsBindLoopback() {
  const offenders = [];
  for (const f of walkTests()) {
    const src = read(f);
    src.split("\n").forEach((line, i) => {
      if (!/\.listen\(/.test(line)) return;
      if (/^\s*(\/\/|\*)/.test(line)) return; // comment
      if (!line.includes("127.0.0.1")) offenders.push(`${f}:${i + 1}`);
    });
  }
  const helper = read("packages/cli/src/test-util.ts");
  const helperBinds = /server\.listen\(port, "127\.0\.0\.1"/.test(helper);
  if (offenders.length === 0 && helperBinds) pass("inv-33:tests-bind-loopback");
  else
    fail(
      "inv-33:tests-bind-loopback",
      `listen() without 127.0.0.1: ${offenders.join(", ") || "none"}; helperBinds=${helperBinds}`,
    );
}

/**
 * INV-34: a theme manifest is a code-and-markup channel, so only the operator
 * may choose it (finding #32). Two halves, both load-bearing:
 *   1. a bare built-in name must never resolve to a repo file, or a repo
 *      shipping themes/ink.yml hijacks `--theme ink` — the documented
 *      invocation (README quick-start, this repo's own Pages workflow);
 *   2. a fetched (npm/git) source must not name its own theme, the same rule
 *      INV-20 already applies to plugins.
 * The guard is provenance, not escaping: manifest slots are raw HTML on
 * purpose, so asserting an escape call would be the wrong shape.
 */
function checkThemeProvenance() {
  const src = read("packages/core/src/theme-manifest.ts");
  const themesSrc = read("packages/core/src/themes.ts");
  // The built-in registry must expose a membership test (not a lookup, which
  // falls back to the default and would answer true for anything).
  const hasBuiltinCheck = /export function isBuiltinTheme\(/.test(themesSrc);
  const usesOwnProperty = /hasOwnProperty\.call\(THEMES/.test(themesSrc);
  // Both guards, in the resolution chokepoint.
  const builtinGuard = /if \(isBuiltinTheme\(ref\) && !isExplicitThemePath\(ref\)\) return null;/.test(src);
  const fetchedGuard = /if \(opts\.fetched && !isExplicitThemePath\(ref\)\)/.test(src);
  // The escape hatch: an explicit path is the operator's decision (D-9).
  const explicitPath = /function isExplicitThemePath\(/.test(src);
  // `themeFile` is the repo's own config key, so a fetched source may not use it.
  const repoThemeFile = /const repoThemeFile = opts\.fetched \? undefined : config\.themeFile;/.test(src);
  // build.ts must drop the repo's OWN theme key on a fetched source. Testing the
  // reference's *shape* instead let a repo write `theme: ./themes/evil.yml` in
  // its own config and get its manifest loaded — a bypass caught by execution.
  const buildSrc = read("packages/core/src/build.ts");
  const repoThemeDropped = /const repoTheme = source\.fetched \? undefined : config\.theme;/.test(buildSrc);
  const operatorWins = /const themeRef = options\.theme \?\? repoTheme;/.test(buildSrc);
  // The renderer re-resolves the theme per page, so the flag must ride along —
  // dropping it here is the same propagation bug that bit the plugin guard.
  const renderPasses = /opts\.renderOptions\.fetched/.test(read("packages/core/src/render.ts"));
  const buildStamps = /fetched: source\.fetched,/.test(buildSrc);
  const buildResolves = /loadThemeManifest\(themeRef, root, \{ fetched: source\.fetched \}\)/.test(buildSrc);
  if (
    hasBuiltinCheck &&
    usesOwnProperty &&
    builtinGuard &&
    fetchedGuard &&
    explicitPath &&
    repoThemeFile &&
    repoThemeDropped &&
    operatorWins &&
    renderPasses &&
    buildStamps &&
    buildResolves
  ) {
    pass("inv-34:theme-manifest-provenance");
  } else {
    fail(
      "inv-34:theme-manifest-provenance",
      `isBuiltinTheme=${hasBuiltinCheck}, ownProperty=${usesOwnProperty}, builtinGuard=${builtinGuard}, ` +
        `fetchedGuard=${fetchedGuard}, explicitPath=${explicitPath}, repoThemeFile=${repoThemeFile}, ` +
        `repoThemeDropped=${repoThemeDropped}, operatorWins=${operatorWins}, ` +
        `renderPasses=${renderPasses}, buildStamps=${buildStamps}, buildResolves=${buildResolves}`,
    );
  }
}

/**
 * INV-35: an authorization decision must be evaluated when it is used, not
 * frozen at construction (finding #33). `needsAuth` was a const computed once
 * in buildRequestHandler, so a key issued against a running server did not
 * turn auth on — while the startup banner tells operators to run
 * `brewdocs keys add` to lock a network instance down. Both guards must read
 * the live state; the domains store is re-read per request for this same
 * reason, so the codebase already had the pattern.
 */
function checkAuthIsLive() {
  const serverSrc = read("packages/cli/src/server.ts");
  const keysSrc = read("packages/cli/src/keys.ts");
  // The per-request reader and its two consumers.
  const reader = /const needsAuthNow = \(\): boolean =>/.test(serverSrc);
  const writeGuard = /if \(!needsAuthNow\(\)\) return "ok";/.test(serverSrc);
  const readGuard = /if \(!needsAuthNow\(\)\) return true;/.test(serverSrc);
  // A frozen const is exactly what regressed; its return must turn this red.
  const frozen = /const needsAuth = Boolean\(token\)/.test(serverSrc);
  // The state helper must distinguish unreadable from empty (INV-29's rule).
  const stateHelper = /export function keyStoreState\(/.test(keysSrc);
  const unreadableIsConfigured =
    /return state === "configured" \|\| state === "unreadable";/.test(keysSrc);
  if (reader && writeGuard && readGuard && !frozen && stateHelper && unreadableIsConfigured) {
    pass("inv-35:auth-decision-is-live");
  } else {
    fail(
      "inv-35:auth-decision-is-live",
      `reader=${reader}, writeGuard=${writeGuard}, readGuard=${readGuard}, ` +
        `frozenConst=${frozen}, stateHelper=${stateHelper}, unreadableIsConfigured=${unreadableIsConfigured}`,
    );
  }
}

/** Every *.test.ts under packages/ (test files only — util files are fine). */
function walkTests() {
  const out = [];
  const walk = (rel) => {
    for (const e of fs.readdirSync(path.join(ROOT, rel), { withFileTypes: true })) {
      const child = `${rel}/${e.name}`;
      if (e.isDirectory()) {
        if (e.name !== "__snapshots__" && e.name !== "node_modules") walk(child);
      } else if (e.name.endsWith(".test.ts")) {
        out.push(child);
      }
    }
  };
  for (const d of ["packages/core", "packages/cli", "packages/plugin-sdk"]) {
    if (fs.existsSync(path.join(ROOT, d))) walk(d);
  }
  return out;
}

/**
 * The generated trust-boundary table must actually contain routes. It
 * silently rendered EMPTY from v4.5.1 through v4.6: the scanner looked for
 * `return async (req, res)` while the routes had moved into `const handle =
 * async (req, res)` (finding #21's wrapper). map:check only compares the
 * committed file against the generator — a generator that matches its own
 * empty output passes — so this asserts content, not just equality. The
 * table is the map's highest-value artifact; an empty one is exactly the
 * quiet erosion the map exists to prevent.
 */
function checkTrustTablePopulated() {
  const map = read("docs/map/PROJECT_MAP.md");
  const rows = (map.match(/^\| `\/[^`]*` \| (GET|POST) \|/gm) ?? []).length;
  if (rows >= 8) pass("map:trust-table-populated");
  else
    fail(
      "map:trust-table-populated",
      `only ${rows} route row(s) — scripts/map.mjs lost the handler scan`,
    );
}

/* ------------------------------------------------------ 3. finding verify */

function findings() {
  const file = path.join(ROOT, "docs", "map", "facts", "findings.json");
  if (!fs.existsSync(file)) return [];
  const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
  return parsed.findings ?? [];
}

function checkFindings() {
  const fixed = findings().filter((f) => f.status === "fixed");
  const known = new Set(results.map((r) => r.name));

  // A finding marked fixed must be provable: either it names a static check
  // that already ran (checkedBy) or a command we can execute (verify).
  const unprovable = fixed.filter((f) => !f.verify && !f.checkedBy);
  if (unprovable.length) {
    fail(
      "findings:fixed-entries-are-provable",
      `marked fixed with neither checkedBy nor verify: ${unprovable.map((f) => `#${f.id}`).join(", ")}`,
    );
  } else {
    pass("findings:fixed-entries-are-provable");
  }

  // A checkedBy pointer to a check that is missing or failing is a lie.
  for (const f of fixed) {
    if (!f.checkedBy) continue;
    const r = results.find((x) => x.name === f.checkedBy);
    if (!r) fail(`finding#${f.id}:link`, `checkedBy "${f.checkedBy}" is not a check this gate runs`);
    else if (!r.ok) fail(`finding#${f.id}:link`, `checkedBy "${f.checkedBy}" is currently failing`);
    else pass(`finding#${f.id}:checked-by-${f.checkedBy}`);
  }

  const vitestFindings = [];
  const otherFindings = [];

  for (const f of fixed) {
    if (!f.verify) continue;
    const match = /^npx vitest run (.+)$/.exec(f.verify.trim());
    if (match) {
      vitestFindings.push({ finding: f, file: match[1].trim() });
    } else {
      otherFindings.push(f);
    }
  }

  // Batch vitest runs into a single process to eliminate redundant cold boots
  // and cut gate wall clock from ~12m to <1m.
  if (vitestFindings.length > 0) {
    const uniqueFiles = [...new Set(vitestFindings.map((v) => v.file))];
    const batchedCmd = `npx vitest run ${uniqueFiles.join(" ")}`;
    try {
      execFileSync(batchedCmd, { cwd: ROOT, stdio: "pipe", shell: true, timeout: 300_000 });
      for (const { finding } of vitestFindings) {
        pass(`finding#${finding.id}:verify`);
      }
    } catch {
      // If the batch failed, run individually so the specific failing finding is pinpointed.
      const memo = new Map();
      for (const { finding, file } of vitestFindings) {
        if (!memo.has(file)) {
          try {
            execFileSync(`npx vitest run ${file}`, { cwd: ROOT, stdio: "pipe", shell: true, timeout: 120_000 });
            memo.set(file, { ok: true });
          } catch (e) {
            const tail = (e.stderr?.toString() || e.stdout?.toString() || "").trim().split("\n").slice(-3).join(" / ");
            const why = e.code === "ETIMEDOUT" ? "timed out after 120s" : e.signal ? `killed by ${e.signal}` : `exit ${e.status ?? "?"}`;
            memo.set(file, { ok: false, error: `verify command failed (${why}) — "${finding.title}"${tail ? ` — ${tail}` : ""}` });
          }
        }
        const res = memo.get(file);
        if (res.ok) pass(`finding#${finding.id}:verify`);
        else fail(`finding#${finding.id}:verify`, res.error);
      }
    }
  }

  for (const f of otherFindings) {
    try {
      execFileSync(f.verify, { cwd: ROOT, stdio: "pipe", shell: true, timeout: 300_000 });
      pass(`finding#${f.id}:verify`);
    } catch (e) {
      const tail = (e.stderr?.toString() || e.stdout?.toString() || "").trim().split("\n").slice(-3).join(" / ");
      const why = e.code === "ETIMEDOUT"
        ? "timed out after 300s"
        : e.signal
        ? `killed by ${e.signal} — likely a load/timeout flake, not a regression`
        : `exit ${e.status ?? "?"}`;
      fail(
        `finding#${f.id}:verify`,
        `verify command failed (${why}) — "${f.title}"${tail ? ` — ${tail}` : ""}`,
      );
    }
  }
}

/* -------------------------------------------------------------------- run */

checkMapDrift();
checkBindDefault();
checkIgnoreScripts();
checkSourceConfinement();
checkEscapeHelpers();
checkWriteEndpointsGuarded();
checkBoundaryContainment();
checkSubdomainValidation();
checkUrlSchemeValidation();
checkOutputContainment();
checkSlotConfinement();
checkCiWorkflows();
checkCorePackaging();
checkKeyScopes();
checkReleaseVerify();
checkTrustProxy();
checkReadGuards();
checkPythonFetchedGuard();
checkPluginFetchedGuard();
checkRendererGolden();
checkMcpHttpGuarded();
checkMcpSharedHandler();
checkCredentialComparison();
checkRequestSurvival();
checkStoredHashNotACredential();
checkManifestFailClosed();
checkSiteParamContainment();
checkPrivateAlwaysGated();
checkKeyStoreFailClosed();
checkStyleChannelBreakout();
checkPostBodyCapped();
checkNumericEnvValidated();
checkTestsBindLoopback();
checkThemeProvenance();
checkAuthIsLive();
checkTrustTablePopulated();
checkFindings();

const failed = results.filter((r) => !r.ok);

if (asJson) {
  console.log(JSON.stringify({ ok: failed.length === 0, results }, null, 2));
} else {
  for (const r of results) {
    console.log(`${r.ok ? "✓" : "✗"} ${r.name}${r.detail && !r.ok ? `\n    ${r.detail}` : ""}`);
  }
  console.log();
  if (failed.length) {
    console.error(`✗ gate failed: ${failed.length} check(s)`);
    process.exit(1);
  }
  console.log(`✓ gate passed (${results.length} checks)`);
}

process.exit(failed.length ? 1 : 0);
