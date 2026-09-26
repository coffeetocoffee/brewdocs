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

/**
 * INV-4: every escape helper must handle quotes. Two exist (render.ts and
 * markdown.ts); a new one that escapes only &<> is exactly how the XSS got in.
 */
function checkEscapeHelpers() {
  const offenders = [];
  const files = [
    "packages/core/src/render.ts",
    "packages/core/src/markdown.ts",
    "packages/cli/src/server.ts",
  ];
  for (const f of files) {
    if (!fs.existsSync(path.join(ROOT, f))) continue;
    const src = read(f);
    for (const m of src.matchAll(/function\s+(\w*escape\w*)\s*\([^)]*\)[^{]*\{([\s\S]{0,600}?)\n\}/gi)) {
      const [_, name, body] = m;
      const escapesQuotes = /&quot;|&#39;|&apos;/.test(body);
      const escapesAngle = /&lt;/.test(body);
      // Only a text/HTML escaper needs quote handling; a URL or path escaper
      // is a different concern and is not asserted here.
      if (escapesAngle && !escapesQuotes) offenders.push(`${f}:${name}`);
    }
  }
  if (offenders.length === 0) pass("inv-4:escape-helpers-quote-safe");
  else
    fail(
      "inv-4:escape-helpers-quote-safe",
      `escape helper(s) escape < but not quotes: ${offenders.join(", ")}`,
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
  const md = read("packages/core/src/markdown.ts");
  const hasSafeUrl = /function safeUrl/.test(md);
  const blocks = /javascript\|vbscript\|data/.test(md);
  const stripsControl = /\\u0000-\\u001f/.test(md);
  if (hasSafeUrl && blocks && stripsControl) pass("inv-7:url-scheme-validation");
  else
    fail(
      "inv-7:url-scheme-validation",
      `safeUrl=${hasSafeUrl}, blocksScriptSchemes=${blocks}, stripsControlChars=${stripsControl}`,
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
    } catch {
      fail(
        `finding#${f.id}:verify`,
        `verify command failed — "${f.title}" may have regressed`,
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
checkBoundaryContainment();
checkSubdomainValidation();
checkUrlSchemeValidation();
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
