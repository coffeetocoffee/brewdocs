#!/usr/bin/env node
/**
 * PROJECT MAP GENERATOR
 * =====================
 * Regenerates docs/map/PROJECT_MAP.md and docs/map/agents-context.json from the
 * source tree plus the hand-written facts in docs/map/facts/.
 *
 *   node scripts/map.mjs          # write the generated views
 *   node scripts/map.mjs --check  # exit 1 if the committed views are stale
 *
 * WHY THIS EXISTS
 * ---------------
 * The repo already had README/AGENTS/ROADMAP, and they drifted: the README
 * claimed 314 tests when there were 311, the roadmap was gitignored, and the
 * server's auth posture lived only in the code. Documents rot because a human
 * has to remember to re-type counts. So nothing here is typed twice: test
 * counts, file/LOC totals, and the HTTP surface table are all parsed out of
 * the tree on every run. `--check` in CI makes staleness a build failure.
 *
 * The parts a machine cannot infer (why a boundary exists, what a decision
 * cost us) live in docs/map/facts/*.json and are treated as input, not output.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const MAP_DIR = path.join(ROOT, "docs", "map");
const FACTS_DIR = path.join(MAP_DIR, "facts");

const read = (p) => fs.readFileSync(p, "utf8");
const exists = (p) => fs.existsSync(p);
const list = (dir, filter) =>
  fs.existsSync(dir) ? fs.readdirSync(dir).filter(filter) : [];

/** Recursively collect files under `dir` whose path matches `match`. */
function walk(dir, match, out = []) {
  if (!fs.existsSync(dir)) return out;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name === "node_modules" || e.name === "dist" || e.name.startsWith(".")) continue;
    const abs = path.join(dir, e.name);
    if (e.isDirectory()) walk(abs, match, out);
    else if (match(abs)) out.push(abs);
  }
  return out;
}

const rel = (p) => path.relative(ROOT, p).replace(/\\/g, "/");

/* ---------------------------------------------------------------- facts */

function loadFacts() {
  if (!exists(FACTS_DIR)) return {};
  const out = {};
  for (const f of list(FACTS_DIR, (n) => n.endsWith(".json"))) {
    const key = f.replace(/\.json$/, "");
    try {
      const parsed = JSON.parse(read(path.join(FACTS_DIR, f)));
      // Each file carries its payload under one non-underscore key (the
      // `_why` field documents the file for a human reading it raw). Unwrap
      // so callers get the payload directly.
      const payloadKeys = Object.keys(parsed).filter((k) => !k.startsWith("_"));
      out[key] = payloadKeys.length === 1 ? parsed[payloadKeys[0]] : parsed;
    } catch (err) {
      throw new Error(`facts/${f} is not valid JSON: ${err.message}`);
    }
  }
  return out;
}

/* ----------------------------------------------------------- derive: size */

function packageStats() {
  const pkgs = list(path.join(ROOT, "packages"), (n) =>
    exists(path.join(ROOT, "packages", n, "package.json")),
  ).sort();
  return pkgs.map((name) => {
    const dir = path.join(ROOT, "packages", name);
    const pkg = JSON.parse(read(path.join(dir, "package.json")));
    const src = walk(dir, (p) => p.endsWith(".ts") && !p.endsWith(".test.ts"));
    const tests = walk(dir, (p) => p.endsWith(".test.ts"));
    const loc = src.reduce((n, f) => n + read(f).split("\n").length, 0);
    const testLoc = tests.reduce((n, f) => n + read(f).split("\n").length, 0);
    return {
      name: pkg.name,
      version: pkg.version,
      role: FACTS_ROLE[name] ?? "",
      srcFiles: src.length,
      srcLoc: loc,
      testFiles: tests.length,
      testLoc,
    };
  });
}

/* --------------------------------------------------- derive: test counts */

/**
 * Count `it(`/`test(` declarations. This is the number the README used to
 * hard-code and get wrong; parsing it removes the whole class of drift.
 *
 * Caveat worth stating in the output: a handful of files declare tests inside
 * a `for` loop over fixtures (bundled examples, real-world packages), so the
 * number vitest reports at runtime is slightly higher than the number of
 * declarations. We report declarations and say so, rather than printing a
 * runtime figure nobody can reproduce from the source.
 */
function testStats() {
  const files = walk(path.join(ROOT, "packages"), (p) => p.endsWith(".test.ts"));
  let total = 0;
  let skipped = 0;
  const loopFiles = [];
  for (const f of files) {
    const src = read(f);
    const lines = src.split("\n");
    for (const _ of src.matchAll(/^\s*(?:it|test)\(/gm)) total++;
    for (const _ of src.matchAll(/^\s*(?:it|test)\.(?:skip|todo)\(/gm)) skipped++;

    // A `for (const …)` appearing before the first declaration at a shallower
    // indent means at least one declaration is generated per fixture.
    const firstDecl = lines.findIndex((l) => /^\s*(?:it|test)\(/.test(l));
    const firstLoop = lines.findIndex((l) => /^\s*for \(const /.test(l));
    if (firstLoop >= 0 && firstDecl > firstLoop) loopFiles.push(rel(f));
  }
  return { files: files.length, total, skipped, loopFiles };
}

/* ------------------------------------------------ derive: HTTP surface */

/**
 * The trust-boundary table is the highest-value artifact in this repo: 13 of
 * the 17 audit findings were in server.ts / render.ts, and every one was an
 * undeclared assumption about caller-controlled input. So we parse the real
 * handler to state, per endpoint, exactly what guards it.
 */
function endpointSurface() {
  const file = path.join(ROOT, "packages", "cli", "src", "server.ts");
  const src = read(file);
  const lines = src.split("\n");

  // Locate the returned async request handler.
  const handlerStart = lines.findIndex((l) => /return async \(req, res\)/.test(l));
  if (handlerStart < 0) throw new Error("could not locate the request handler in server.ts");

  const routes = [];
  const routeRe = /url\.pathname === "([^"]+)"/;
  for (let i = handlerStart; i < lines.length; i++) {
    const m = routeRe.exec(lines[i]);
    if (!m) continue;

    // The guard checks appear within the next few lines of the route test.
    const window = lines.slice(i, i + 12).join("\n");
    const method =
      /req\.method === "POST"/.test(lines[i]) || /req\.method === "POST"/.test(lines[i + 1] ?? "")
        ? "POST"
        : "GET";

    const guards = [];
    // Write guards: authorize(req, "<scope>"); read guards: authorizeRead(req).
    if (/authorize\(req,/.test(window)) guards.push("authorize");
    if (/!authorizeRead\(req\)/.test(window)) guards.push("authorizeRead");
    if (/requireSiteAccess\(/.test(window)) guards.push("requireSiteAccess");
    if (/guardSource\(/.test(window)) guards.push("sourceRoot");

    routes.push({
      path: m[1],
      method,
      guards: [...new Set(guards)],
      file: rel(file),
      line: i + 1,
    });
  }

  // Source-reading endpoints must declare confinement, or the boundary is
  // open. This is checked by the gate, asserted from the parsed truth.
  return routes.filter((r, idx, all) => all.findIndex((x) => x.path === r.path && x.method === r.method) === idx);
}

/* ----------------------------------------------------- derive: bind defaults */

function bindFacts() {
  const src = read(path.join(ROOT, "packages", "cli", "src", "index.ts"));
  const def = /BREWDOCS_HOST\s*\?\?\s*"([^"]+)"/.exec(src)?.[1];
  const explicit = /server\.listen\(port,\s*host/.test(src);
  const autoToken = /openToNetwork/.test(src);
  return { defaultHost: def ?? "?", explicitBind: explicit, autoTokenOnNetworkBind: autoToken };
}

/* ---------------------------------------------------------- derive: gaps */

/**
 * Findings are hand-written (they encode judgement), but their STATUS is
 * cross-checked against the tree so a "fixed" entry cannot silently regress:
 * `verify` commands are executed by scripts/gate.mjs, not by this generator.
 */
function gapsTable(facts) {
  return (facts.findings?.findings ?? facts.findings ?? []).map((f) => ({
    ...f,
    proven: Boolean(f.checkedBy || f.verify),
  }));
}

/* ------------------------------------------------------------ generate md */

const FACTS_ROLE = {};

function renderMarkdown(d) {
  const { stats, tests, routes, bind, facts } = d;
  const L = [];
  const p = (s = "") => L.push(s);

  p(`# Project Map — ${facts.project?.name ?? "brewdocs"}`);
  p();
  p(`> **Generated file. Do not edit.** Run \`npm run map\` to regenerate;`);
  p(`> CI (\`npm run map:check\`) fails if this is out of date.`);
  p(`>`);
  p(`> Facts a machine cannot infer live in [\`facts/\`](./facts) and are reviewed by humans.`);
  p(`> Everything below with a number in it is parsed from the source tree.`);
  p();
  p(`_Generated: ${d.generatedAt}_`);
  p();

  /* -- what this is -- */
  if (facts.project?.what) {
    p(`## What this is`);
    p();
    p(facts.project.what);
    p();
  }

  /* -- shape -- */
  p(`## Shape`);
  p();
  p(`| Package | Version | Role | Source | Tests |`);
  p(`| --- | --- | --- | --- | --- |`);
  for (const s of stats) {
    p(
      `| \`${s.name}\` | ${s.version} | ${s.role || "—"} | ${s.srcFiles} files / ${s.srcLoc.toLocaleString()} loc | ${s.testFiles} files / ${s.testLoc.toLocaleString()} loc |`,
    );
  }
  p();
  p(
    `**${tests.total} test declarations across ${tests.files} files**${tests.skipped ? ` (${tests.skipped} explicitly skipped)` : ""} — parsed from the tree, not typed.`,
  );
  if (tests.loopFiles.length) {
    p();
    p(
      `> ${tests.loopFiles.length} file(s) declare tests inside a fixture loop, so a \`vitest\` run reports more cases than the declaration count above: ` +
        tests.loopFiles.map((f) => `\`${path.basename(f)}\``).join(", ") +
        `. That is expected — the declaration count is the stable number.`,
    );
  }
  p();

  /* -- trust boundaries: the important one -- */
  p(`## Trust boundaries`);
  p();
  p(
    `Every entry point that accepts caller-controlled input, and the exact guard on it. ` +
      `This is derived from \`packages/cli/src/server.ts\` on every run.`,
  );
  p();
  p(`| Endpoint | Method | Guards | Defined at |`);
  p(`| --- | --- | --- | --- |`);
  for (const r of routes) {
    const g = r.guards.length ? r.guards.map((x) => `\`${x}\``).join(", ") : "**none**";
    p(`| \`${r.path}\` | ${r.method} | ${g} | \`${r.file}:${r.line}\` |`);
  }
  p();
  p(`### Invariants a change must not break`);
  p();
  if (facts.invariants) {
    for (const inv of facts.invariants) {
      p(`- **${inv.id}** — ${inv.rule}`);
      p(`  - _why:_ ${inv.why}`);
      if (inv.enforcedBy) p(`  - _enforced by:_ ${inv.enforcedBy}`);
    }
  }
  p();
  p(`### Server defaults`);
  p();
  p(`- bind address default: \`${bind.defaultHost}\`${bind.explicitBind ? " (explicit `listen(port, host)`)" : " **— NOT EXPLICIT, CHECK THIS**"}`);
  p(
    `- network bind without configured auth auto-generates a token: ${bind.autoTokenOnNetworkBind ? "yes" : "**no — check this**"}`,
  );
  p();

  /* -- data & state -- */
  if (facts.state) {
    p(`## Where state lives`);
    p();
    p(`| Store | File | Written by |`);
    p(`| --- | --- | --- |`);
    for (const s of facts.state) p(`| ${s.what} | \`${s.file}\` | ${s.by} |`);
    p();
  }

  /* -- boundaries / non-goals -- */
  if (facts.boundaries) {
    p(`## Boundaries and non-goals`);
    p();
    for (const b of facts.boundaries) p(`- ${b}`);
    p();
  }

  /* -- decisions -- */
  if (facts.decisions) {
    p(`## Decisions worth knowing`);
    p();
    for (const dec of facts.decisions) {
      p(`<details><summary><b>${dec.id}</b> — ${dec.title}</summary>`);
      p();
      p(dec.body);
      p();
      p(`</details>`);
      p();
    }
  }

  /* -- findings -- */
  const gaps = gapsTable(facts);
  if (gaps.length) {
    p(`## Findings`);
    p();
    p(
      `Severity and the write-up are human judgement. **Status is not**: every entry marked ` +
        `\`fixed\` names the check that proves it, and \`npm run gate\` fails if that check ` +
        `stops passing. Reproduce the whole table with \`npm run gate\`.`,
    );
    p();
    const fixedCount = gaps.filter((g) => g.status === "fixed").length;
    const partialCount = gaps.filter((g) => g.status === "partial").length;
    const openCount = gaps.length - fixedCount - partialCount;
    const openHigh = gaps.filter(
      (g) => g.status !== "fixed" && (g.severity === "high" || g.severity === "med-high"),
    ).length;
    p(
      `**${fixedCount} fixed / ${openCount} open${partialCount ? ` / ${partialCount} partial` : ""}** — ${openHigh} of the not-yet-fixed ones are high or med-high.`,
    );
    p();
    p(`| # | Severity | Finding | Status | Proven by |`);
    p(`| --- | --- | --- | --- | --- |`);
    for (const g of gaps) {
      const proof = g.checkedBy
        ? `\`${g.checkedBy}\``
        : g.verify
          ? `\`${g.verify}\``
          : "—";
      p(`| ${g.id} | ${g.severity} | ${g.title} | ${g.status} | ${proof} |`);
    }
    p();
    if (facts.fixHints !== false) {
      const withHints = gaps.filter((g) => g.fixHint);
      if (withHints.length) {
        p(`### How to close the open ones`);
        p();
        for (const g of withHints) p(`- **#${g.id}** — ${g.fixHint}`);
        p();
      }
    }
  }

  /* -- how to work here -- */
  if (facts.working) {
    p(`## Working in this repo`);
    p();
    p(facts.working);
    p();
  }

  return L.join("\n");
}

/* ------------------------------------------------------------ machine view */

function renderAgentContext(d) {
  return (
    JSON.stringify(
      {
        generatedAt: d.generatedAt,
        note: "Generated by scripts/map.mjs. Machine-readable reload for agents; see PROJECT_MAP.md for prose.",
        project: d.facts.project ?? {},
        stats: d.stats,
        tests: d.tests,
        bind: d.bind,
        endpoints: d.routes,
        invariants: d.facts.invariants ?? [],
        findings: gapsTable(d.facts),
      },
      null,
      2,
    ) + "\n"
  );
}

/* ------------------------------------------------------------------- main */

const isCheck = process.argv.includes("--check");

const facts = loadFacts();
// Roles are presentation, keyed by workspace directory name.
FACTS_ROLE.core = "pipeline: extract → model → render";
FACTS_ROLE.cli = "commands + hosting server";
FACTS_ROLE["plugin-sdk"] = "adapter/hook contracts";

const data = {
  generatedAt: new Date().toISOString().slice(0, 10),
  facts,
  stats: packageStats(),
  tests: testStats(),
  routes: endpointSurface(),
  bind: bindFacts(),
};

const md = renderMarkdown(data);
const json = renderAgentContext(data);

const targets = [
  [path.join(MAP_DIR, "PROJECT_MAP.md"), md],
  [path.join(MAP_DIR, "agents-context.json"), json],
];

/**
 * Staleness compares everything EXCEPT the generation date. Otherwise a map
 * committed today fails `map:check` tomorrow purely because the calendar
 * moved, which trains people to ignore the check.
 */
const withoutDate = (s) =>
  s.replace(/^_Generated: \d{4}-\d{2}-\d{2}_$/m, "_Generated: <date>_")
    .replace(/"generatedAt": "\d{4}-\d{2}-\d{2}"/, '"generatedAt": "<date>"');

if (isCheck) {
  const stale = targets.filter(
    ([f, body]) => !exists(f) || withoutDate(read(f)) !== withoutDate(body),
  );
  if (stale.length) {
    console.error("✗ project map is stale — run `npm run map`");
    for (const [f] of stale) console.error(`    ${rel(f)}`);
    process.exit(1);
  }
  console.log("✓ project map is up to date");
} else {
  fs.mkdirSync(MAP_DIR, { recursive: true });
  for (const [f, body] of targets) fs.writeFileSync(f, body, "utf8");
  console.log(`✓ wrote ${targets.map(([f]) => rel(f)).join(", ")}`);
}

export { endpointSurface, testStats, packageStats, bindFacts };
