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
 * ship as an open write surface; this asserts the guard from the parsed routes.
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
    if (!/authorize\(|guardSource\(|requireSiteAccess\(/.test(block)) {
      offenders.push(route[1]);
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
  // The slug guard must exist AND be applied before path resolution.
  const hasRe = /SAFE_SUBDOMAIN\s*=/.test(src);
  const applied = /SAFE_SUBDOMAIN\.test\(sub\)/.test(src);
  if (hasRe && applied) pass("inv-6:subdomain-slug-guard");
  else fail("inv-6:subdomain-slug-guard", `regex=${hasRe}, applied=${applied}`);
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

  // The guard itself: repo-config plugins are dropped when source.fetched...
  const guarded = /if \(source\.fetched && configPlugins\.length > 0\)/.test(buildSrc);
  // ...and the drop is announced, not silent.
  const warns = /cannot choose code that runs on your machine/.test(buildSrc);

  // Every place a Source is rebuilt for a per-version worktree, or handed to
  // build() from the CLI, must carry `fetched` through.
  const versioned = (
    buildSrc.match(/root: srcRoot, name: source\.name, fetched: source\.fetched/g) ?? []
  ).length;
  const cliPropagates = /fetched: resolved\.source\.fetched/.test(cliSrc);

  if (guarded && warns && versioned >= 3 && cliPropagates)
    pass("inv-20:fetched-source-cannot-name-plugins");
  else
    fail(
      "inv-20:fetched-source-cannot-name-plugins",
      `guard=${guarded}, warns=${warns}, versionedRebuilds=${versioned}/3, cliPropagates=${cliPropagates}`,
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

  for (const f of fixed) {
    if (!f.verify) continue;
    // Verify commands are shell strings run verbatim. They are written
    // quote-free on purpose: going through an argv array plus `shell: true`
    // mangles nested quotes on Windows, which silently turned a real check
    // into a false failure the first time this gate ran.
    try {
      execFileSync(f.verify, { cwd: ROOT, stdio: "pipe", shell: true });
      pass(`finding#${f.id}:verify`);
    } catch (e) {
      // Distinguish a real failure from a signal kill (timeout/OOM under load),
      // and surface the tail of the command's output. A bare "may have
      // regressed" once hid a load-induced timeout behind a false regression.
      const tail = (e.stderr?.toString() || e.stdout?.toString() || "").trim().split("\n").slice(-3).join(" / ");
      const why = e.signal
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
