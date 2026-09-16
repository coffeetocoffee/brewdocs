import {
  build,
  buildGallery,
  buildVersion,
  buildVersions,
  buildMulti,
  createStorage,
  deploySite,
  deriveSubdomain,
  combineSubdomain,
  discoverVersions,
  exportSite,
  listThemes,
  loadConfig,
  resolveInput,
  badgeSvg,
  analyzeSymbols,
  diagnose,
  diffSymbols,
  buildDocModel,
  extractFromSource,
  extractVersion,
  gateDecision,
  buildMarkdown,
  buildMarkdownMulti,
  loadCoverageHistory,
  postGitHubComment,
  readAcknowledgment,
  readPackageVersion,
  recordCoverage,
  renderChangelogMarkdown,
  renderCiMarkdown,
  renderDiffHtml,
  sparklineSvg,
  sparklineUnicode,
  versionLabel,
  writeAcknowledgment,
  insertChangelogSection,
  buildDrafts,
  applyDrafts,
  proveSource,
  proveSummary,
  harvestExamples,
  docModelSchemaJson,
  buildModel,
  buildWorkspaces,
  detectWorkspaces,
  loadPlugins,
  listLocales,
  rollupCoverage,
  runMcpServer,
  setDraftExpiry,
  addOrgMember,
  aggregateOrgStats,
  createOrg,
  deleteOrg,
  listOrgSites,
  listOrgs,
  removeOrgMember,
  addDomain,
  listDomains,
  readTlsFile,
  removeDomain,
  verifyDomain,
  wellKnownPath,
  auditSite,
  renderAuditText,
  publishPlugin,
  listRegistryPlugins as listPlugins,
  searchPlugins,
  unpublishPlugin,
  installPlugin,
  buildRegistryGallery,
  snapshotOf,
  compareDrift,
  loadDriftSnapshot,
  saveDriftSnapshot,
  renderDriftText,
  addFederatedRepo,
  buildFederatedPage,
  listFederatedRepos,
  loadFederation,
  removeFederatedRepo,
  searchFederation,
  type BrewDocsConfig,
  type DoctorReport,
  type RenderOptions,
  type StorageAdapter,
  type SymbolDoc,
} from "@brewdocs/core";
import { createServer, createSecureServer } from "./server.js";
import { addKey, listKeys, revokeKey, ALL_SCOPES, type ApiKeyRecord } from "./keys.js";
import * as http from "node:http";
import * as fs from "node:fs";
import * as crypto from "node:crypto";
import * as os from "node:os";
import * as path from "node:path";

interface BuildArgs {
  source: string;
  out: string;
  theme?: string;
  dark: boolean;
  version?: string;
  name?: string;
  multi: boolean;
  watch: boolean;
  noDocmodel: boolean;
  plugins: string[];
  /** undefined = follow brewdocs.yml, true/false = explicit CLI override. */
  cache?: boolean;
  /** Editable in-page "Try it" runners under every example (v2.5). */
  playground: boolean;
  /** v3.0: UI locale (brewdocs.yml `locale:` is the default). */
  locale?: string;
}

function parseBuild(argv: string[]): BuildArgs {
  let source: string | undefined;
  let out = "dist";
  let theme: string | undefined;
  let dark = false;
  let version: string | undefined;
  let name: string | undefined;
  let multi = false;
  let watch = false;
  let noDocmodel = false;
  let cache: boolean | undefined;
  let playground = false;
  let locale: string | undefined;
  const plugins: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--out" || arg === "-o") {
      out = argv[++i] ?? "dist";
    } else if (arg.startsWith("--out=")) {
      out = arg.slice("--out=".length);
    } else if (arg === "--theme" || arg === "-t") {
      theme = argv[++i];
    } else if (arg.startsWith("--theme=")) {
      theme = arg.slice("--theme=".length);
    } else if (arg === "--version" || arg === "-v") {
      version = argv[++i];
    } else if (arg.startsWith("--version=")) {
      version = arg.slice("--version=".length);
    } else if (arg === "--name" || arg === "-n") {
      name = argv[++i];
    } else if (arg.startsWith("--name=")) {
      name = arg.slice("--name=".length);
    } else if (arg === "--plugins") {
      const list = argv[++i] ?? "";
      for (const p of list.split(",")) if (p.trim()) plugins.push(p.trim());
    } else if (arg.startsWith("--plugins=")) {
      for (const p of arg.slice("--plugins=".length).split(",")) if (p.trim()) plugins.push(p.trim());
    } else if (arg === "--cache") {
      cache = true;
    } else if (arg === "--no-cache") {
      cache = false;
    } else if (arg === "--locale") {
      locale = argv[++i]; // value-taking flag: skip it or "id" becomes <source>
    } else if (arg.startsWith("--locale=")) {
      locale = arg.slice("--locale=".length);
    } else if (arg === "--badge" || arg === "--min-coverage") {
      i++; // value-taking flags the builder ignores, but their values must not become <source>
    } else if (arg.startsWith("--badge=") || arg.startsWith("--min-coverage=")) {
      // inline form, nothing to skip
    } else if (arg === "--multi") {
      multi = true;
    } else if (arg === "--playground") {
      playground = true;
    } else if (arg === "--no-docmodel") {
      noDocmodel = true;
    } else if (arg === "--watch" || arg === "-w") {
      watch = true;
    } else if (arg === "--dark") {
      dark = true;
    } else if (!arg.startsWith("-") && source === undefined) {
      source = arg;
    }
  }
  if (!source) {
    throw new Error(
      "usage: brewdocs build <source> [--out <dir>] [--theme <name>] [--dark] [--version <v>] [--name <subdomain>] [--multi] [--watch] [--no-docmodel] [--plugins <a,b>] [--cache] [--playground] [--locale <code>]",
    );
  }
  return { source, out, theme, dark, version, name, multi, watch, noDocmodel, plugins, cache, playground, locale };
}

function printDoctorReport(report: ReturnType<typeof diagnose>): void {
  console.log(`🩺 ${report.title} — docs coverage: ${report.score}%`);
  const examplesNote =
    report.examplesRun !== undefined
      ? ` · examples proven: ${report.examplesPassed}/${report.examplesRun}`
      : "";
  console.log(
    `   symbols: ${report.documentedSymbols}/${report.totalSymbols} documented · params: ${report.paramsDocumented}/${report.paramsTotal} · returns: ${report.returnsDocumented}/${report.returnsTotal} · examples: ${report.examplesTotal}${examplesNote}`,
  );
  if (report.issues.length === 0) {
    console.log("   no issues found. Well brewed! ☕");
    return;
  }
  const bySeverity = (s: string) => report.issues.filter((i) => i.severity === s);
  const errors = bySeverity("error");
  const warnings = bySeverity("warning");
  const infos = bySeverity("info");
  for (const [label, list, icon] of [
    ["errors", errors, "✗"],
    ["warnings", warnings, "⚠"],
    ["hints", infos, "·"],
  ] as const) {
    if (list.length === 0) continue;
    console.log(`\n   ${label} (${list.length}):`);
    for (const issue of list.slice(0, 40)) {
      console.log(`     ${icon} ${issue.symbol} — ${issue.message}`);
    }
    if (list.length > 40) console.log(`     … and ${list.length - 40} more`);
  }
}

/** Merge CLI flags over brewdocs.yml defaults into render options. */function mergeOptions(
  args: BuildArgs,
  config: BrewDocsConfig,
  sourceRoot: string,
): RenderOptions {
  return {
    theme: args.theme ?? config.theme,
    dark: args.dark || Boolean(config.dark),
    multiPage: args.multi || Boolean(config.multi),
    emitDocmodel: !args.noDocmodel && config.docmodel !== false,
    plugins: loadPlugins(args.plugins, sourceRoot),
    cache: args.cache,
    playground: args.playground || Boolean(config.playground),
    locale: args.locale ?? config.locale,
  };
}

/**
 * Resolve a CLI source argument (local path, npm package name, or GitHub URL)
 * into a buildable Source. Without this, npm names were path.resolve()d into
 * nonexistent local dirs and built empty doc sites silently.
 */
function resolveCliSource(
  input: string,
  nameOverride: string | undefined,
): {
  src: { root: string; name?: string };
  name: string | undefined;
  cleanup: () => void;
} {
  const resolved = resolveInput(input);
  return {
    src: { root: resolved.source.root, name: nameOverride ?? resolved.source.name },
    name: resolved.source.name,
    cleanup: resolved.cleanup,
  };
}

/** Build a storage adapter from --storage flag, env vars, and brewdocs.yml. */
function buildStorage(kind: string | undefined, config: BrewDocsConfig): StorageAdapter | undefined {
  const useS3 = kind === "s3" || config.storage === "s3";
  if (!useS3) return undefined;
  const s3 = config.s3 ?? {};
  return createStorage("s3", {
    s3: {
      bucket: process.env.BREWDOCS_S3_BUCKET ?? s3.bucket,
      region: process.env.BREWDOCS_S3_REGION ?? s3.region,
      endpoint: process.env.BREWDOCS_S3_ENDPOINT ?? s3.endpoint,
      accessKeyId: process.env.BREWDOCS_S3_ACCESS_KEY_ID ?? s3.accessKeyId,
      secretAccessKey: process.env.BREWDOCS_S3_SECRET_ACCESS_KEY ?? s3.secretAccessKey,
      publicDomain: process.env.BREWDOCS_PUBLIC_DOMAIN ?? s3.publicDomain,
    },
  });
}

function getFlag(argv: string[], flag: string): string | undefined {
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === flag) return argv[i + 1];
    if (argv[i].startsWith(`${flag}=`)) return argv[i].slice(flag.length + 1);
  }
  return undefined;
}

/** Resolve `--format mdx` (anything but `md`) to a Markdown dialect. */
function markdownFormat(argv: string[]): "md" | "mdx" {
  const f = getFlag(argv, "--format");
  return f === "mdx" ? "mdx" : "md";
}

/** PR number from GitHub Actions env (pull_request ref or event payload). */
function prNumberFromEnv(): number | undefined {
  const ref = process.env.GITHUB_REF;
  if (ref) {
    const m = /^refs\/pull\/(\d+)\//.exec(ref);
    if (m) return Number(m[1]);
  }
  const eventPath = process.env.GITHUB_EVENT_PATH;
  if (eventPath && fs.existsSync(eventPath)) {
    try {
      const event = JSON.parse(fs.readFileSync(eventPath, "utf8")) as {
        pull_request?: { number?: number };
        number?: number;
      };
      const n = event.pull_request?.number ?? event.number;
      if (typeof n === "number") return n;
    } catch {
      /* ignore */
    }
  }
  return undefined;
}

/**
 * CI guardian: compare the working tree against a base ref and (optionally)
 * post the report as a PR comment. Exit 1 on --min-coverage breach or
 * --fail-on-breaking.
 */
async function runCi(rest: string[]): Promise<void> {
  const source = rest[0];
  const base = getFlag(rest, "--base");
  if (!source || source.startsWith("-") || !base) {
    throw new Error(
      "usage: brewdocs ci <source> --base <ref> [--post] [--min-coverage <pct>] [--fail-on-breaking] [--out <file>] [--json]",
    );
  }
  const { src, cleanup } = resolveCliSource(source, undefined);
  try {
    const headExtract = extractFromSource(src);
    const headReport = analyzeSymbols(headExtract.title, headExtract.symbols);

    let baseReport: DoctorReport | null = null;
    let baseSymbols: SymbolDoc[] | null = null;
    try {
      // Strict: a missing/unfetched base must fail loudly, not silently
      // produce an empty diff against the working tree.
      const baseExtract = await extractVersion(src, base, { strict: true });
      baseReport = analyzeSymbols(baseExtract.title, baseExtract.symbols);
      baseSymbols = baseExtract.symbols;
    } catch (err) {
      console.error(
        `! could not extract base "${base}": ${err instanceof Error ? err.message : err}`,
      );
    }

    const headVersion = readPackageVersion(src.root);
    const diff = baseSymbols
      ? diffSymbols(base, baseSymbols, headVersion, headExtract.symbols)
      : null;

    const config = loadConfig(src.root);
    const minCoverage =
      Number(getFlag(rest, "--min-coverage")) || config.minCoverage || undefined;

    // Prove runs as part of the CI report (skippable via --no-prove since
    // it compiles each example).
    let proveProven: { passed: number; total: number } | undefined;
    if (!rest.includes("--no-prove")) {
      try {
        const proven = proveSource(src);
        if (proven.length) {
          const s = proveSummary(proven);
          proveProven = { passed: s.passed, total: s.proven };
        }
      } catch {
        /* prove is additive; never fail the CI report on it */
      }
    }

    // The current build joins the trend for the comment; persistence is
    // opt-in via `brewdocs doctor --record`.
    const history: ReturnType<typeof loadCoverageHistory> = [
      ...loadCoverageHistory(src.root),
      {
        version: headVersion,
        score: headReport.score,
        timestamp: new Date().toISOString(),
        totalSymbols: headReport.totalSymbols,
        documentedSymbols: headReport.documentedSymbols,
      },
    ];

    const markdown = renderCiMarkdown({
      title: headExtract.title,
      head: headReport,
      base: baseReport,
      diff,
      history,
      baseVersion: base,
      headVersion,
      minCoverage,
      examplesProven: proveProven,
    });

    const outFlag = getFlag(rest, "--out");
    if (outFlag) {
      const outPath = path.resolve(process.cwd(), outFlag);
      fs.mkdirSync(path.dirname(outPath), { recursive: true });
      fs.writeFileSync(outPath, markdown, "utf8");
      console.log(`CI report -> ${outPath}`);
    }
    if (getFlag(rest, "--json")) {
      console.log(
        JSON.stringify(
          { head: headReport, base: baseReport, diff, minCoverage: minCoverage ?? null },
          null,
          2,
        ),
      );
    } else if (!outFlag) {
      console.log(markdown);
    }

    if (rest.includes("--post")) {
      const token = process.env.GITHUB_TOKEN ?? process.env.BREWDOCS_GITHUB_TOKEN;
      const repo = getFlag(rest, "--repo") ?? process.env.GITHUB_REPOSITORY;
      const pr = Number(getFlag(rest, "--pr")) || prNumberFromEnv();
      if (!token) throw new Error("--post requires GITHUB_TOKEN (or BREWDOCS_GITHUB_TOKEN)");
      if (!repo) throw new Error("--post requires GITHUB_REPOSITORY or --repo owner/name");
      if (!pr) {
        throw new Error(
          "--post requires a pull request number (--pr N, or run in a pull_request context)",
        );
      }
      const result = await postGitHubComment({ token, repo, pr, markdown });
      console.log(`${result.created ? "Created" : "Updated"} PR comment: ${result.url}`);
    }

    if (minCoverage !== undefined && headReport.score < minCoverage) {
      console.error(
        `x docs coverage ${headReport.score}% is below the ${minCoverage}% minimum`,
      );
      process.exitCode = 1;
    } else if (rest.includes("--fail-on-breaking") && diff && diff.breakingCount > 0) {
      console.error(`x ${diff.breakingCount} breaking change(s) vs ${base}`);
      process.exitCode = 1;
    }
    if (proveProven && proveProven.passed < proveProven.total) {
      console.error(
        `x ${proveProven.total - proveProven.passed} doc example(s) fail typecheck`,
      );
      process.exitCode = 1;
    }
  } finally {
    cleanup();
  }
}

/** Release gate: breaking changes need a generated guide or an acknowledgment. */
async function runGate(rest: string[]): Promise<void> {
  const source = rest[0];
  const from = getFlag(rest, "--from");
  if (!source || source.startsWith("-") || !from) {
    throw new Error(
      "usage: brewdocs gate <source> --from <tag> [--to <tag>] [--out <dir>] [--acknowledge <note>] [--json]",
    );
  }
  const to = getFlag(rest, "--to");
  const { src, cleanup } = resolveCliSource(source, undefined);
  try {
    const older = await extractVersion(src, from, { strict: true });
    let newerSymbols: SymbolDoc[];
    let toLabel: string;
    if (to) {
      const newer = await extractVersion(src, to, { strict: true });
      newerSymbols = newer.symbols;
      toLabel = to;
    } else {
      newerSymbols = extractFromSource(src).symbols;
      toLabel = readPackageVersion(src.root);
    }
    const diff = diffSymbols(from, older.symbols, toLabel, newerSymbols);
    const title = older.title;

    const outDirFlag = getFlag(rest, "--out");
    let guideGenerated = false;
    if (outDirFlag) {
      const outDir = path.resolve(process.cwd(), outDirFlag);
      fs.mkdirSync(outDir, { recursive: true });
      const html = path.join(outDir, "diff.html");
      const md = path.join(outDir, "MIGRATION.md");
      fs.writeFileSync(html, renderDiffHtml(diff, title), "utf8");
      fs.writeFileSync(md, renderChangelogMarkdown(diff, title), "utf8");
      guideGenerated = true;
      console.log(`Migration guide -> ${md}`);
      console.log(`Diff page -> ${html}`);
    }

    const ackValue = getFlag(rest, "--acknowledge");
    const ackGiven =
      rest.includes("--acknowledge") ||
      rest.some((a) => a.startsWith("--acknowledge="));
    const acknowledged = ackGiven || readAcknowledgment(src.root, from, toLabel);
    if (ackGiven) {
      const note =
        ackValue && !ackValue.startsWith("-") ? ackValue : undefined;
      const file = writeAcknowledgment(src.root, from, toLabel, note);
      console.log(`Acknowledgment recorded -> ${file}`);
    }

    let unprovenExamples: number | undefined;
    if (rest.includes("--require-proven")) {
      try {
        const proven = proveSource(src);
        const s = proveSummary(proven);
        unprovenExamples = s.failed;
      } catch {
        /* prove is additive; never fail the gate on it */
      }
    }

    const decision = gateDecision({
      breakingCount: diff.breakingCount,
      guideGenerated,
      acknowledged,
      unprovenExamples,
    });

    if (getFlag(rest, "--json")) {
      console.log(
        JSON.stringify(
          {
            ok: decision.ok,
            reason: decision.reason,
            guideGenerated,
            acknowledged,
            diff,
          },
          null,
          2,
        ),
      );
    } else {
      console.log(`v${versionLabel(from)} -> v${versionLabel(toLabel)}: ${diff.summary}`);
      console.log(`${decision.ok ? "PASS" : "FAIL"}: ${decision.reason}`);
    }
    if (!decision.ok) process.exitCode = 1;
  } finally {
    cleanup();
  }
}

export async function run(argv: string[]): Promise<void> {
  const [command, ...rest] = argv;
  if (!command || command === "help" || command === "--help" || command === "-h") {
    printHelp();
    return;
  }

  if (command === "themes") {
    for (const t of listThemes()) {
      console.log(`  ${t.name.padEnd(12)} ${t.label}`);
    }
    return;
  }

  if (command === "locales") {
    for (const l of listLocales()) {
      console.log(`  ${l.code.padEnd(6)} ${l.label}`);
    }
    return;
  }

  if (command === "versions") {
    const src = rest[0];
    if (!src) throw new Error("usage: brewdocs versions <source>");
    const versions = await discoverVersions(path.resolve(process.cwd(), src));
    console.log(versions.map((v) => `v${v}`).join("\n"));
    return;
  }

  if (command === "doctor") {
    const args = parseBuild(rest);
    const { src, cleanup } = resolveCliSource(args.source, args.name);
    try {
      // v1.2 workspace mode: doctor runs per package, then rolls up.
      if (rest.includes("--workspaces")) {
        const members = detectWorkspaces(src.root);
        if (members.length === 0) {
          throw new Error(
            `no workspaces found in ${src.root} (expected "workspaces" in package.json)`,
          );
        }
        const models = new Map();
        for (const m of members) {
          models.set(
            m.name,
            buildModel({ root: m.root, name: m.name }),
          );
        }
        const rollup = rollupCoverage(members, models);
        if (getFlag(rest, "--json")) {
          console.log(JSON.stringify(rollup, null, 2));
        } else {
          console.log(
            `🩺 workspace — docs coverage: ${rollup.score}% (${members.length} packages)`,
          );
          for (const p of rollup.packages) {
            console.log(
              `   ${p.name}: ${p.score}% (${p.report.documentedSymbols}/${p.report.totalSymbols} documented)`,
            );
          }
        }
        const threshold =
          Number(getFlag(rest, "--min-coverage")) ||
          loadConfig(src.root).minCoverage;
        if (threshold !== undefined && rollup.score < threshold) {
          console.error(
            `✗ workspace docs coverage ${rollup.score}% is below the ${threshold}% minimum`,
          );
          process.exitCode = 1;
        }
        return;
      }
      const report = diagnose(src);
      const json = getFlag(rest, "--json");
      const badge = getFlag(rest, "--badge");
      const config = loadConfig(src.root);
      const threshold =
        Number(getFlag(rest, "--min-coverage")) ||
        config.minCoverage ||
        (json ? undefined : 0);

      const record = rest.includes("--record");
      let history = loadCoverageHistory(src.root);
      if (record) {
        if (fs.existsSync(args.source)) {
          history = recordCoverage(
            src.root,
            report,
            readPackageVersion(src.root),
          );
        } else {
          console.log(
            "(--record skipped: trend history lives in the local checkout's .brewdocs/coverage.json)",
          );
        }
      }

      if (json) {
        console.log(JSON.stringify(report, null, 2));
      } else {
        printDoctorReport(report);
        if (history.length >= 2) {
          const scores = history.map((r) => r.score);
          const delta = scores[scores.length - 1] - scores[scores.length - 2];
          console.log(
            `   trend: ${sparklineUnicode(scores)} ${scores[scores.length - 1]}% (${
              delta >= 0 ? "+" : "-"
            }${Math.abs(delta)} vs previous build, ${history.length} recorded)`,
          );
        }
      }
      if (badge) {
        const badgePath = path.resolve(process.cwd(), badge);
        fs.writeFileSync(badgePath, badgeSvg(report), "utf8");
        console.log(`🏅 Badge written -> ${badgePath}`);
      }
      const trendSvg = getFlag(rest, "--trend-svg");
      if (trendSvg) {
        const svgPath = path.resolve(process.cwd(), trendSvg);
        fs.writeFileSync(
          svgPath,
          sparklineSvg(history.map((r) => r.score)),
          "utf8",
        );
        console.log(`📈 Trend sparkline -> ${svgPath}`);
      }
      if (threshold !== undefined && report.score < threshold) {
        console.error(
          `✗ docs coverage ${report.score}% is below the ${threshold}% minimum`,
        );
        process.exitCode = 1;
      }
    } finally {
      cleanup();
    }
    return;
  }

  if (command === "diff") {
    const source = rest[0];
    const from = getFlag(rest, "--from");
    const to = getFlag(rest, "--to");
    if (!source || source.startsWith("-")) {
      throw new Error("usage: brewdocs diff <source> --from <tag> --to <tag> [--json] [--out <dir>]");
    }
    if (!from || !to) throw new Error("both --from <tag> and --to <tag> are required");
    const { src, cleanup } = resolveCliSource(source, undefined);
    try {
      // Sequential, not Promise.all: two `git worktree add`s on the same repo
      // race on git's worktree lock and both silently fall back to the
      // working tree, producing a bogus empty diff.
      const older = await extractVersion(src, from);
      const newer = await extractVersion(src, to);
      const diff = diffSymbols(from, older.symbols, to, newer.symbols);
      const outFlag = getFlag(rest, "--out");
      if (outFlag) {
        const outDir = path.resolve(process.cwd(), outFlag);
        fs.mkdirSync(outDir, { recursive: true });
        const title = newer.title ?? older.title;
        const outFile = path.join(outDir, "diff.html");
        fs.writeFileSync(outFile, renderDiffHtml(diff, title), "utf8");
        console.log(`📜 Diff page -> ${outFile}`);
      }
      if (getFlag(rest, "--json") || !outFlag) {
        if (!outFlag) {
          console.log(
            `${diff.summary} (+${diff.added.length} −${diff.removed.length} ~${diff.changed.length})`,
          );
        }
        console.log(JSON.stringify(diff, null, 2));
      }
    } finally {
      cleanup();
    }
    return;
  }

  if (command === "changelog") {
    const source = rest[0];
    const from = getFlag(rest, "--from");
    const to = getFlag(rest, "--to");
    if (!source || source.startsWith("-")) {
      throw new Error(
        "usage: brewdocs changelog <source> --from <tag> --to <tag> [--file <changelog.md>] [--out <dir>] [--json]",
      );
    }
    if (!from || !to) throw new Error("both --from <tag> and --to <tag> are required");
    const { src, cleanup } = resolveCliSource(source, undefined);
    try {
      const older = await extractVersion(src, from, { strict: true });
      const newer = await extractVersion(src, to, { strict: true });
      const diff = diffSymbols(from, older.symbols, to, newer.symbols);
      const title = newer.title ?? older.title;
      const section = renderChangelogMarkdown(diff, title);

      if (getFlag(rest, "--json")) {
        console.log(JSON.stringify({ section, diff }, null, 2));
      } else {
        console.log(section);
      }

      const outFile = getFlag(rest, "--out");
      if (outFile) {
        const outPath = path.resolve(process.cwd(), outFile);
        fs.mkdirSync(path.dirname(outPath), { recursive: true });
        fs.writeFileSync(outPath, section, "utf8");
        console.log(`📝 Changelog section -> ${outPath}`);
      }

      const file = getFlag(rest, "--file");
      if (file) {
        const filePath = path.resolve(process.cwd(), file);
        const existing = fs.existsSync(filePath)
          ? fs.readFileSync(filePath, "utf8")
          : "";
        fs.writeFileSync(
          filePath,
          insertChangelogSection(existing, section),
          "utf8",
        );
        console.log(`📝 Inserted into ${filePath}`);
      }
    } finally {
      cleanup();
    }
    return;
  }

  if (command === "ci") {
    return runCi(rest);
  }

  if (command === "gate") {
    return runGate(rest);
  }

  if (command === "build-all") {
    const args = parseBuild(rest);
    const { src, cleanup } = resolveCliSource(args.source, args.name);
    const config = loadConfig(src.root);
    const outDir = path.resolve(process.cwd(), args.out);
    try {
      if (rest.includes("--workspaces")) {
        const files = buildWorkspaces(src, outDir, mergeOptions(args, config, src.root));
        console.log(`☕ Brewed ${files.length} workspace site(s) -> ${outDir}`);
        return;
      }
      const files = await buildVersions(src, outDir, mergeOptions(args, config, src.root));
      console.log(`☕ Brewed ${files.length} version page(s) -> ${outDir}`);
    } finally {
      cleanup();
    }
    return;
  }

  if (command === "build") {
    const args = parseBuild(rest);
    const resolved = resolveCliSource(args.source, args.name);
    const { src, cleanup } = resolved;
    const config = loadConfig(src.root);
    const outDir = path.resolve(process.cwd(), args.out);
    const opts = mergeOptions(args, config, src.root);

    const doBuild = async (): Promise<void> => {
      const outFile = args.version
        ? await buildVersion(src, outDir, args.version, opts)
        : args.multi
          ? (await buildMulti(src, outDir, opts))[0]
          : build(src, outDir, opts);
      console.log(`☕ Brewed docs -> ${outFile}`);
    };

    if (args.watch) {
      await doBuild();
      console.log(`👀 Watching ${src.root} for changes…  (Ctrl+C to stop)`);
      let timer: NodeJS.Timeout | undefined;
      fs.watch(src.root, { recursive: true }, (_event, file) => {
        if (!file) return;
        if (!/\.(ts|js|py|go|md|mdx|json|yaml|yml|graphql|gql|rs|java|cs|rb|toml|gemspec|csproj)$/.test(file)) return;
        if (timer) clearTimeout(timer);
        timer = setTimeout(() => void doBuild(), 200);
      });
      return;
    }

    await doBuild();
    cleanup();
    return;
  }

  if (command === "export") {
    const args = parseBuild(rest);
    const { src, cleanup } = resolveCliSource(args.source, args.name);
    const config = loadConfig(src.root);
    const outDir = path.resolve(process.cwd(), args.out);
    try {
      const outFile = await exportSite(src, outDir, mergeOptions(args, config, src.root));
      console.log(`📦 Exported static site -> ${outFile}`);
      if (rest.includes("--markdown")) {
        const md = buildMarkdown(src, outDir, { format: markdownFormat(rest) });
        console.log(`📝 Exported Markdown reference -> ${md}`);
      }
      if (rest.includes("--json")) {
        const jsonFile = buildDocModel(src, outDir);
        console.log(`🧊 Exported DocModel JSON -> ${jsonFile}`);
      }
    } finally {
      cleanup();
    }
    return;
  }

  if (command === "markdown") {
    const args = parseBuild(rest);
    const { src, cleanup } = resolveCliSource(args.source, args.name);
    const outDir = path.resolve(process.cwd(), args.out);
    try {
      if (args.multi) {
        const files = buildMarkdownMulti(src, outDir, { format: markdownFormat(rest) });
        console.log(`📝 Markdown reference (${files.length} files) -> ${outDir}`);
      } else {
        const md = buildMarkdown(src, outDir, { format: markdownFormat(rest) });
        console.log(`📝 Markdown reference -> ${md}`);
      }
    } finally {
      cleanup();
    }
    return;
  }

  if (command === "docmodel") {
    const args = parseBuild(rest);
    const { src, cleanup } = resolveCliSource(args.source, args.name);
    const outDir = path.resolve(process.cwd(), args.out);
    try {
      const file = buildDocModel(src, outDir);
      console.log(`🧊 DocModel JSON -> ${file}`);
      if (rest.includes("--schema")) {
        const schemaFile = path.join(outDir, "docmodel.schema.json");
        fs.writeFileSync(schemaFile, docModelSchemaJson(), "utf8");
        console.log(`📐 DocModel schema -> ${schemaFile}`);
      }
    } finally {
      cleanup();
    }
    return;
  }

  if (command === "draft") {
    const args = parseBuild(rest);
    const { src, cleanup } = resolveCliSource(args.source, args.name);
    try {
      const proposals = buildDrafts(src);
      if (proposals.length === 0) {
        console.log("☕ Nothing to draft — every exported symbol is documented.");
        return;
      }

      if (rest.includes("--fix")) {
        const changed = applyDrafts(proposals);
        console.log(`✍️  Drafted JSDoc for ${proposals.length} symbol(s) in:`);
        for (const f of changed) console.log(`   ${f}`);
        return;
      }

      console.log(
        `✍️  ${proposals.length} undocumented exported symbol(s) — run with --fix to write them:`,
      );
      for (const p of proposals) {
        console.log(`   ${p.file}:${p.line}  ${p.kind} ${p.symbol}`);
        for (const line of p.jsdoc.split("\n")) console.log(`     ${line}`);
        console.log("");
      }
    } finally {
      cleanup();
    }
    return;
  }

  if (command === "prove") {
    const args = parseBuild(rest);
    const { src, cleanup } = resolveCliSource(args.source, args.name);
    try {
      const results = proveSource(src);
      if (results.length === 0) {
        console.log("☕ No examples to prove.");
        return;
      }
      let pass = 0;
      let fail = 0;
      for (const r of results) {
        if (r.skipped) {
          console.log(`· ${r.symbol} example#${r.index} — skipped (not code)`);
          continue;
        }
        if (r.ok) {
          pass++;
          console.log(`✓ ${r.symbol} example#${r.index}`);
        } else {
          fail++;
          console.log(`✗ ${r.symbol} example#${r.index}`);
          for (const line of (r.error ?? "").split("\n")) console.log(`   ${line}`);
        }
      }
      const total = pass + fail;
      console.log(
        `🔬 Proved ${pass}/${total} examples typecheck` +
          (results.some((r) => r.skipped) ? " (some skipped as non-code)" : ""),
      );
      if (rest.includes("--strict") && fail > 0) process.exitCode = 1;
    } finally {
      cleanup();
    }
    return;
  }

  if (command === "harvest") {
    const args = parseBuild(rest);
    const { src, cleanup } = resolveCliSource(args.source, args.name);
    try {
      const proposals = harvestExamples(src);
      if (proposals.length === 0) {
        console.log("☕ Nothing to harvest — every exported symbol has an example.");
        return;
      }
      if (getFlag(rest, "--json")) {
        console.log(JSON.stringify(proposals, null, 2));
        return;
      }
      console.log(
        `🌾 ${proposals.length} example proposal(s) from README + tests:`,
      );
      for (const p of proposals) {
        console.log(`   ${p.symbol} (${p.kind}) — from ${p.origin}`);
        for (const line of p.snippet.split("\n")) console.log(`     ${line}`);
        console.log("");
      }
    } finally {
      cleanup();
    }
    return;
  }

  if (command === "init") {
    const out = getFlag(rest, "--out") ?? "brewdocs.yml";
    const target = path.resolve(process.cwd(), out);
    if (fs.existsSync(target)) {
      throw new Error(`${out} already exists — remove it or use --out <file>`);
    }
    let name = "";
    let desc = "";
    try {
      const p = JSON.parse(fs.readFileSync(path.join(process.cwd(), "package.json"), "utf8"));
      if (typeof p.name === "string") name = p.name;
      if (typeof p.description === "string") desc = p.description;
    } catch {
      /* not a package; leave blanks */
    }
    const tmpl = `# BrewDocs configuration
# https://github.com/coffeetocoffee/brewdocs
name: ${name}
description: ${desc}
theme: coffee
dark: false
# minCoverage: 80
# storage: local   # local | s3
# org: ""           # multi-tenant namespace for hosted deploys
`;
    fs.writeFileSync(target, tmpl, "utf8");
    console.log(`📝 Wrote ${target}`);
    return;
  }

  if (command === "preview") {
    const args = parseBuild(rest);
    const { src, cleanup } = resolveCliSource(args.source, args.name);
    const config = loadConfig(src.root);
    const out = fs.mkdtempSync(path.join(os.tmpdir(), "brewdocs-preview-"));
    const files = await buildVersions(src, out, mergeOptions(args, config, src.root));
    const port = Number(getFlag(rest, "--port") ?? "4000");
    const server = serveStatic(out, port);
    server.on("close", cleanup);
    console.log(`👀 Previewing ${files.length} page(s) at http://localhost:${port}`);
    console.log(`   (Ctrl+C to stop)`);
    return;
  }

  if (command === "deploy") {
    const args = parseBuild(rest);
    const resolved = resolveCliSource(args.source, args.name);
    const { src, cleanup } = resolved;
    const config = loadConfig(src.root);
    const storageKind = getFlag(rest, "--storage") ?? "local";
    const org = getFlag(rest, "--org") ?? config.org;
    const privateFlag = rest.includes("--private") || rest.some((a) => a.startsWith("--private"));
    const privateValue = getFlag(rest, "--private");
    const draftFlag = rest.includes("--draft");
    const visibility =
      privateFlag || config.private || draftFlag ? "private" : "public";
    if (draftFlag && !(privateFlag || config.private)) {
      throw new Error("--draft requires --private (draft links are token-gated)");
    }
    // --draft defaults to a 24h link unless --draft-expires sets one.
    const draftHours = Number(getFlag(rest, "--draft-hours") ?? "24");
    const draftExpires = draftFlag
      ? new Date(Date.now() + draftHours * 3600_000).toISOString()
      : undefined;
    // --private without a value auto-generates a token; with a value, use it.
    const token =
      privateFlag && privateValue && !privateValue.startsWith("-")
        ? privateValue
        : privateFlag || draftFlag
          ? crypto.randomBytes(16).toString("hex")
          : undefined;
    const baseSub =
      args.name ?? config.name ?? resolved.name ?? deriveSubdomain(src);
    const sub = org ? combineSubdomain(org, baseSub) : baseSub;
    const storage = buildStorage(storageKind, config);

    try {
      const result = await deploySite(
        src,
        path.resolve(process.cwd(), args.out),
        sub,
        mergeOptions(args, config, src.root),
        storage,
        { org, visibility, token, draft: draftFlag, draftExpires },
      );
      console.log(`🚀 Deployed -> ${result.url}`);
      if (result.visibility === "private") {
        console.log(
          `🔒 Private site. Access with token: ${token}\n   (?token=${token} or Authorization: Bearer ${token})`,
        );
        if (draftFlag) {
          console.log(
            `✏️  Shareable draft link: ${result.url}/?token=${token}\n   expires ${draftExpires} (extend via 'brewdocs drafts extend ${sub}')`,
          );
        }
      }
      if (rest.includes("--markdown")) {
        const md = buildMarkdown(src, path.resolve(process.cwd(), args.out), {
          format: markdownFormat(rest),
        });
        console.log(`📝 Markdown reference -> ${md}`);
      }
    } finally {
      cleanup();
    }
    return;
  }

  if (command === "serve") {
    const hostingDir = path.resolve(
      process.cwd(),
      getFlag(rest, "--hosting") ?? "./hosting",
    );
    const port = Number(getFlag(rest, "--port") ?? "4000");
    const storageKind = getFlag(rest, "--storage") ?? "local";
    const config = loadConfig(process.cwd());
    const storage = buildStorage(storageKind, config);
    const token = process.env.BREWDOCS_TOKEN;

    // v2.5 TLS: --tls-cert/--tls-key (or BREWDOCS_TLS_CERT/KEY) serve the
    // same pipeline over HTTPS. Both must be readable PEM files.
    const certFile = getFlag(rest, "--tls-cert") ?? process.env.BREWDOCS_TLS_CERT;
    const keyFile = getFlag(rest, "--tls-key") ?? process.env.BREWDOCS_TLS_KEY;
    if (certFile || keyFile) {
      if (!certFile || !keyFile) {
        throw new Error("TLS needs both --tls-cert and --tls-key (cert + private key PEM files)");
      }
      const cert = readTlsFile(path.resolve(process.cwd(), certFile));
      const key = readTlsFile(path.resolve(process.cwd(), keyFile));
      if (!cert || !key) {
        throw new Error(`TLS files unreadable: ${cert ? keyFile : certFile}`);
      }
      const server = createSecureServer(hostingDir, storage, token, undefined, { cert, key });
      server.listen(port, () => {
        console.log(`☕ BrewDocs hosting (https) on https://localhost:${port}`);
        console.log(`   serving sites from: ${hostingDir}`);
        if (storage) console.log(`   storage backend: s3`);
      });
      return;
    }

    const server = createServer(hostingDir, storage, token);
    server.listen(port, () => {
      console.log(`☕ BrewDocs hosting on http://localhost:${port}`);
      console.log(`   serving sites from: ${hostingDir}`);
      if (storage) console.log(`   storage backend: s3`);
    });
    return;
  }

  if (command === "gallery") {
    const out = path.resolve(process.cwd(), getFlag(rest, "--out") ?? "gallery");
    const theme = getFlag(rest, "--theme");
    const examplesDir = path.resolve(process.cwd(), getFlag(rest, "--src") ?? "examples");
    const entries = fs
      .readdirSync(examplesDir)
      .map((name) => path.join(examplesDir, name))
      .filter(
        (p) =>
          fs.statSync(p).isDirectory() &&
          fs.existsSync(path.join(p, "package.json")),
      )
      .map((p) => ({ name: path.basename(p), root: p }));
    if (entries.length === 0) {
      throw new Error(`No example packages found in ${examplesDir}`);
    }
    const idx = buildGallery(entries, out, { theme });
    console.log(`🖼️  Gallery built -> ${idx}`);
    return;
  }

  if (command === "keys") {
    const sub = rest[0];
    const hosting = path.resolve(process.cwd(), getFlag(rest, "--hosting") ?? "./hosting");
    if (sub === "add") {
      const scopeFlag = getFlag(rest, "--scope");
      const scopes = scopeFlag
        ? scopeFlag.split(",").map((s) => s.trim()).filter(Boolean)
        : [...ALL_SCOPES];
      const { key } = addKey(hosting, { scopes, label: getFlag(rest, "--label") });
      console.log(`🔑 ${key}`);
      console.log(`   scopes: ${scopes.join(", ")}  (stored in ${hosting}/.keys.json)`);
    } else if (sub === "list") {
      const keys = listKeys(hosting);
      if (!keys.length) {
        console.log(`No API keys in ${hosting}/.keys.json`);
      } else {
        for (const k of keys) {
          console.log(`- ${k.hash.slice(0, 12)}…  scopes=${k.scopes.join(",")}  sites=${k.ownedSites.length}${k.label ? `  (${k.label})` : ""}`);
        }
      }
    } else if (sub === "revoke") {
      const target = rest[1];
      if (!target) throw new Error("usage: brewdocs keys revoke <key-or-hash>");
      const ok = revokeKey(hosting, target);
      console.log(ok ? "🔥 revoked" : "key not found");
    } else {
      throw new Error("usage: brewdocs keys add|list|revoke");
    }
    return;
  }

  if (command === "drafts") {
    const sub = rest[0];
    const hosting = path.resolve(process.cwd(), getFlag(rest, "--hosting") ?? "./hosting");
    if (sub === "list") {
      for (const d of fs.readdirSync(hosting)) {
        const manifestPath = path.join(hosting, d, ".brewdocs.json");
        if (!fs.existsSync(manifestPath)) continue;
        try {
          const m = JSON.parse(fs.readFileSync(manifestPath, "utf8")) as {
            draft?: boolean;
            draftExpires?: string;
          };
          if (m.draft) {
            console.log(`- ${d}${m.draftExpires ? `  expires ${m.draftExpires}` : "  no expiry"}`);
          }
        } catch {
          /* skip unreadable manifests */
        }
      }
    } else if (sub === "extend") {
      const target = rest[1];
      const hours = Number(getFlag(rest, "--hours") ?? "24");
      if (!target) throw new Error("usage: brewdocs drafts extend <subdomain> [--hours 24]");
      const expires = new Date(Date.now() + hours * 3600_000).toISOString();
      const ok = setDraftExpiry(hosting, target, expires);
      console.log(ok ? `⏳ draft ${target} extended to ${expires}` : `no site named ${target}`);
    } else if (sub === "revoke") {
      const target = rest[1];
      if (!target) throw new Error("usage: brewdocs drafts revoke <subdomain>");
      const ok = setDraftExpiry(hosting, target, null);
      console.log(ok ? `🔥 draft ${target} revoked` : `no site named ${target}`);
    } else {
      throw new Error("usage: brewdocs drafts list|extend|revoke");
    }
    return;
  }

  if (command === "cloud") {
    const sub = rest[0];
    const hosting = path.resolve(process.cwd(), getFlag(rest, "--hosting") ?? "./hosting");
    if (sub === "org") {
      const op = rest[1];
      if (op === "create") {
        const name = rest[2];
        if (!name) throw new Error("usage: brewdocs cloud org create <name>");
        const record = createOrg(hosting, name);
        if (!record) throw new Error(`org "${name}" already exists`);
        console.log(`🏢 org ${record.name} created (stored in ${hosting}/.cloud.json)`);
      } else if (op === "list") {
        const orgs = listOrgs(hosting);
        if (!orgs.length) {
          console.log(`No orgs in ${hosting}/.cloud.json`);
        } else {
          for (const o of orgs) {
            console.log(`- ${o.name}  members=${o.members.length}  sites=${o.sites.length}`);
          }
        }
      } else if (op === "add-member") {
        const name = rest[2];
        const key = getFlag(rest, "--key");
        if (!name || !key) {
          throw new Error("usage: brewdocs cloud org add-member <name> --key <bd_live_…|hash> [--role admin|member] [--label <n>]");
        }
        const role = getFlag(rest, "--role") === "admin" ? "admin" : "member";
        const ok = addOrgMember(hosting, name, key, { role, label: getFlag(rest, "--label") });
        if (!ok) throw new Error(`no org named ${name}`);
        console.log(`👤 member added to ${name} (role=${role})`);
      } else if (op === "remove-member") {
        const name = rest[2];
        const key = getFlag(rest, "--key");
        if (!name || !key) {
          throw new Error("usage: brewdocs cloud org remove-member <name> --key <bd_live_…|hash>");
        }
        const ok = removeOrgMember(hosting, name, key);
        console.log(ok ? "👋 member removed" : "member not found");
      } else if (op === "delete") {
        const name = rest[2];
        if (!name) throw new Error("usage: brewdocs cloud org delete <name>");
        const ok = deleteOrg(hosting, name);
        console.log(ok ? `🗑️  org ${name} deleted` : `no org named ${name}`);
      } else {
        throw new Error("usage: brewdocs cloud org create|list|add-member|remove-member|delete");
      }
    } else if (sub === "sites") {
      const name = rest[1];
      if (!name) throw new Error("usage: brewdocs cloud sites <org>");
      const sites = listOrgSites(hosting, name);
      if (!sites.length) {
        console.log(`No sites claimed by org ${name}`);
      } else {
        for (const s of sites) console.log(`- ${s}`);
      }
    } else if (sub === "stats") {
      const name = rest[1];
      if (!name) throw new Error("usage: brewdocs cloud stats <org>");
      let all: Record<string, { views: number; builds: number }> = {};
      try {
        all = JSON.parse(fs.readFileSync(path.join(hosting, ".analytics.json"), "utf8"));
      } catch {
        /* no traffic yet */
      }
      const rollup = aggregateOrgStats(all, listOrgSites(hosting, name));
      console.log(`📊 org ${name}: ${rollup.views} views · ${rollup.builds} builds across ${rollup.sites.length} site(s)`);
      for (const s of rollup.sites) {
        const st = all[s] ?? { views: 0, builds: 0 };
        console.log(`   - ${s}  views=${st.views}  builds=${st.builds}`);
      }
    } else {
      throw new Error("usage: brewdocs cloud org|sites|stats");
    }
    return;
  }

  if (command === "domains") {
    const sub = rest[0];
    const hosting = path.resolve(process.cwd(), getFlag(rest, "--hosting") ?? "./hosting");
    if (sub === "add") {
      const domain = rest[1];
      const site = getFlag(rest, "--site");
      if (!domain || !site) {
        throw new Error("usage: brewdocs domains add <domain> --site <subdomain>");
      }
      const record = addDomain(hosting, domain, site);
      if (!record) throw new Error(`invalid domain/site: ${domain} / ${site}`);
      console.log(`🌐 ${record.domain} -> ${record.subdomain} (pending verification)`);
      console.log(`   publish this at ${record.domain}${wellKnownPath()}:`);
      console.log(`   ${record.token}`);
    } else if (sub === "list") {
      const domains = listDomains(hosting);
      if (!domains.length) {
        console.log(`No custom domains in ${hosting}/.domains.json`);
      } else {
        for (const d of domains) {
          console.log(`- ${d.domain} -> ${d.subdomain}  ${d.verified ? "verified" : "pending"}`);
        }
      }
    } else if (sub === "verify") {
      const domain = rest[1];
      if (!domain) throw new Error("usage: brewdocs domains verify <domain>");
      const ok = await verifyDomain(hosting, domain);
      console.log(ok ? `✅ ${domain} verified` : `⏳ ${domain} still pending (publish the token first)`);
    } else if (sub === "remove") {
      const domain = rest[1];
      if (!domain) throw new Error("usage: brewdocs domains remove <domain>");
      const ok = removeDomain(hosting, domain);
      console.log(ok ? `🗑️  ${domain} removed` : `no domain named ${domain}`);
    } else {
      throw new Error("usage: brewdocs domains add|list|verify|remove");
    }
    return;
  }

  if (command === "audit") {
    const dir = path.resolve(process.cwd(), rest[0] ?? "dist");
    const report = auditSite(dir);
    if (rest.includes("--json")) {
      console.log(JSON.stringify(report, null, 2));
    } else {
      console.log(renderAuditText(report));
    }
    const minScore = Number(getFlag(rest, "--min-score") || 0);
    const group = getFlag(rest, "--group");
    const failedGroup =
      group && (group === "a11y" || group === "seo" || group === "perf")
        ? report.groups[group] < minScore
        : false;
    if (minScore && (group ? failedGroup : report.score < minScore)) {
      console.error(
        group
          ? `x ${group} score ${report.groups[group as "a11y" | "seo" | "perf"]}% is below the ${minScore}% minimum`
          : `x audit score ${report.score}% is below the ${minScore}% minimum`,
      );
      process.exitCode = 1;
    }
    return;
  }

  if (command === "registry") {
    const sub = rest[0];
    const registryDir = path.resolve(
      process.cwd(),
      getFlag(rest, "--registry") ?? process.env.BREWDOCS_REGISTRY ?? "./registry-store",
    );
    if (sub === "publish") {
      const modulePath = rest[1];
      const name = getFlag(rest, "--name");
      const version = getFlag(rest, "--version");
      if (!modulePath || !name || !version) {
        throw new Error(
          "usage: brewdocs registry publish <module.cjs> --name <n> --version <x.y.z> [--kind plugin|adapter|theme] [--description <d>] [--author <a>] [--keywords a,b] [--registry <dir>]",
        );
      }
      const keywords = (getFlag(rest, "--keywords") ?? "")
        .split(",")
        .map((k) => k.trim())
        .filter(Boolean);
      const entry = publishPlugin(registryDir, path.resolve(process.cwd(), modulePath), {
        name,
        version,
        kind: (getFlag(rest, "--kind") as "plugin" | "adapter" | "theme" | undefined) ?? "plugin",
        description: getFlag(rest, "--description"),
        author: getFlag(rest, "--author"),
        keywords: keywords.length ? keywords : undefined,
      });
      if (!entry) {
        process.exitCode = 1;
        return;
      }
      console.log(`📦 ${entry.name}@${entry.version} published -> ${registryDir}`);
      return;
    }
    if (sub === "list" || sub === "search") {
      const query = sub === "search" ? rest[1] ?? "" : "";
      const entries = sub === "search" ? searchPlugins(registryDir, query) : listPlugins(registryDir);
      if (rest.includes("--json")) {
        console.log(JSON.stringify(entries, null, 2));
      } else if (entries.length === 0) {
        console.log(`No plugins in ${registryDir}/.registry.json${query ? ` matching "${query}"` : ""}`);
      } else {
        for (const p of entries) {
          console.log(`- ${p.name}@${p.version}  kind=${p.kind}  installs=${p.installs}  ${p.description ?? ""}`);
        }
      }
      return;
    }
    if (sub === "install") {
      const name = rest[1];
      const into = path.resolve(process.cwd(), getFlag(rest, "--into") ?? ".");
      if (!name) throw new Error("usage: brewdocs registry install <name> --into <source-dir>");
      const result = installPlugin(registryDir, name, into);
      if (!result) {
        console.error(`x no plugin named "${name}" in ${registryDir}`);
        process.exitCode = 1;
        return;
      }
      console.log(`📥 installed ${name}@${result.entry.version} -> ${into}`);
      console.log(`   add to brewdocs.yml plugins: [${result.spec}] or pass --plugins ${result.spec}`);
      return;
    }
    if (sub === "remove") {
      const name = rest[1];
      if (!name) throw new Error("usage: brewdocs registry remove <name>");
      const ok = unpublishPlugin(registryDir, name);
      console.log(ok ? `🗑️  ${name} unpublished` : `no plugin named ${name}`);
      return;
    }
    if (sub === "gallery") {
      const out = path.resolve(process.cwd(), getFlag(rest, "--out") ?? "marketplace");
      const file = buildRegistryGallery(registryDir, out);
      console.log(`🛒 Marketplace gallery -> ${file}`);
      return;
    }
    throw new Error("usage: brewdocs registry publish|list|search|install|remove|gallery");
  }

  if (command === "drift") {
    const source = rest[0];
    if (!source || source.startsWith("-")) {
      throw new Error(
        "usage: brewdocs drift <source> [--record] [--from <ref>] [--json] [--fail-on-drift]",
      );
    }
    const { src, cleanup } = resolveCliSource(source, undefined);
    try {
      const current = extractFromSource(src);
      const json = getFlag(rest, "--json");

      if (rest.includes("--record")) {
        const label = readPackageVersion(src.root);
        const snapshot = snapshotOf(label, current.symbols);
        const file = saveDriftSnapshot(src.root, snapshot);
        console.log(
          `🌊 drift baseline recorded — ${snapshot.symbols.length} symbol(s) @ ${label} -> ${file}`,
        );
        return;
      }

      const fromRef = getFlag(rest, "--from");
      let baseline: ReturnType<typeof loadDriftSnapshot> = null;
      let baselineLabel: string;
      if (fromRef) {
        // Historical comparison: extract the tagged revision from git. Strict
        // so a bad ref fails loudly instead of silently comparing to itself.
        const older = await extractVersion(src, fromRef, { strict: true });
        baseline = snapshotOf(fromRef, older.symbols);
        baselineLabel = fromRef;
      } else {
        baseline = loadDriftSnapshot(src.root);
        baselineLabel = baseline?.label ?? "(none)";
      }
      if (!baseline) {
        throw new Error(
          `no drift baseline in ${path.join(src.root, ".brewdocs", "drift.json")} — run \`brewdocs drift <source> --record\` first, or pass --from <ref>`,
        );
      }

      const report = compareDrift(baseline, {
        title: current.title,
        label: readPackageVersion(src.root),
        symbols: current.symbols,
      });
      if (json) {
        console.log(JSON.stringify(report, null, 2));
      } else {
        console.log(renderDriftText(report));
      }
      if (rest.includes("--fail-on-drift") && report.stale.length > 0) {
        console.error(
          `x ${report.stale.length} symbol(s) drifted (code changed, docs didn't)`,
        );
        process.exitCode = 1;
      }
    } finally {
      cleanup();
    }
    return;
  }

  if (command === "federate") {
    const sub = rest[0];
    const storeDir = path.resolve(
      process.cwd(),
      getFlag(rest, "--store") ?? process.env.BREWDOCS_FEDERATION ?? "./federation",
    );
    if (sub === "add") {
      const name = rest[1];
      const target = rest[2];
      if (!name || !target) {
        throw new Error(
          "usage: brewdocs federate add <name> <docmodel.json | dir> [--url <site-url>] [--store <dir>]",
        );
      }
      const repo = addFederatedRepo(storeDir, name, path.resolve(process.cwd(), target), {
        url: getFlag(rest, "--url"),
      });
      if (!repo) {
        process.exitCode = 1;
        return;
      }
      console.log(
        `🔭 indexed ${repo.name}${repo.version ? `@${repo.version}` : ""} — ${repo.symbols.length} symbol(s) -> ${storeDir}`,
      );
      return;
    }
    if (sub === "list") {
      const repos = listFederatedRepos(storeDir);
      if (rest.includes("--json")) {
        console.log(JSON.stringify(repos, null, 2));
      } else if (repos.length === 0) {
        console.log(`Nothing indexed in ${storeDir} — try \`brewdocs federate add mylib ./mylib/dist\``);
      } else {
        for (const r of repos) {
          console.log(
            `- ${r.name}${r.version ? `@${r.version}` : ""}  ${r.symbols.length} symbol(s)  ${r.generatedAt ?? ""}`,
          );
        }
      }
      return;
    }
    if (sub === "remove") {
      const name = rest[1];
      if (!name) throw new Error("usage: brewdocs federate remove <name> [--store <dir>]");
      const ok = removeFederatedRepo(storeDir, name);
      console.log(ok ? `🗑️  ${name} removed from the federation` : `no repo named ${name}`);
      return;
    }
    if (sub === "search") {
      // Query = positional words only; value-taking flags (--store/--limit)
      // and their values must not leak into the search string.
      const VALUE_FLAGS = new Set(["--store", "--limit"]);
      const words: string[] = [];
      for (let i = 1; i < rest.length; i++) {
        const a = rest[i];
        if (VALUE_FLAGS.has(a)) {
          i++; // skip the flag's value
          continue;
        }
        if (a.startsWith("-")) continue;
        words.push(a);
      }
      const query = words.join(" ");
      if (!query) {
        throw new Error("usage: brewdocs federate search <query...> [--limit <n>] [--json] [--store <dir>]");
      }
      const limit = Number(getFlag(rest, "--limit")) || 20;
      const hits = searchFederation(loadFederation(storeDir), query, { limit });
      if (rest.includes("--json")) {
        console.log(JSON.stringify(hits, null, 2));
      } else if (hits.length === 0) {
        console.log(`no symbols match "${query}" across ${listFederatedRepos(storeDir).length} repo(s)`);
      } else {
        for (const h of hits) {
          console.log(`- ${h.name} (${h.kind}) — ${h.repo}${h.url ? `  ${h.url}` : ""}`);
        }
      }
      return;
    }
    if (sub === "page") {
      const out = path.resolve(process.cwd(), getFlag(rest, "--out") ?? "federation-site");
      const file = buildFederatedPage(storeDir, out);
      console.log(`🔭 Federated search page -> ${file}`);
      return;
    }
    throw new Error(
      "usage: brewdocs federate add|list|remove|search|page [--store <dir>]",
    );
  }

  if (command === "mcp") {
    const file = rest[0] ?? getFlag(rest, "--docmodel") ?? "docmodel.json";
    const resolved = path.resolve(process.cwd(), file);
    if (!fs.existsSync(resolved)) {
      throw new Error(
        `${resolved} not found — run \`brewdocs build <src> --out <dir>\` first (docmodel.json is emitted by default)`,
      );
    }
    await runMcpServer(resolved);
    return;
  }

  console.error(`Unknown command: ${command}`);
  printHelp();
  process.exitCode = 1;
}

const STATIC_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".txt": "text/plain; charset=utf-8",
  ".map": "application/json",
};

/** Minimal static file server used by `brewdocs preview`. */
function serveStatic(dir: string, port: number): http.Server {
  const root = path.resolve(dir);
  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    let rel = decodeURIComponent(url.pathname);
    if (rel.endsWith("/")) rel += "index.html";
    const filePath = path.join(root, rel);
    if (!filePath.startsWith(root) || !fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
      res.writeHead(404, { "content-type": "text/plain" }).end("Not found");
      return;
    }
    const ext = path.extname(filePath);
    res.writeHead(200, { "content-type": STATIC_TYPES[ext] ?? "application/octet-stream" });
    fs.createReadStream(filePath).pipe(res);
  });
  server.listen(port);
  return server;
}

function printHelp(): void {
  console.log(`BrewDocs — Brew your docs, serve them hot.

Usage:
  brewdocs build <source> [--out <dir>] [--theme <name>] [--dark] [--version <v>] [--multi] [--watch] [--no-docmodel] [--plugins <a,b>] [--cache] [--playground]
  brewdocs build-all <source> [--out <dir>] [--theme <name>] [--dark] [--workspaces]
  brewdocs export <source> [--out <dir>] [--theme <name>] [--dark] [--multi] [--markdown] [--json] [--playground]
  brewdocs markdown <source> [--out <dir>] [--format md|mdx] [--multi]
  brewdocs docmodel <source> [--out <dir>] [--schema]   Machine-readable DocModel artifact
  brewdocs draft <source> [--fix]   Scaffold JSDoc for undocumented symbols
  brewdocs prove <source> [--strict]   Typecheck every @example against the package
  brewdocs harvest <source> [--json]   Propose examples from README + tests
  brewdocs init [--out <file>]   Scaffold a brewdocs.yml config
  brewdocs preview <source> [--port 4000]  Build and serve locally
  brewdocs deploy <source> [--name <sub>] [--out <hosting>] [--theme <name>] [--dark] [--storage s3]
                    [--org <name>] [--private [token]] [--draft [--draft-hours N]] [--markdown]
  brewdocs gallery [--src <dir>] [--out <dir>] [--theme <name>]
  brewdocs serve [--hosting <dir>] [--port 4000] [--storage s3] [--tls-cert <pem> --tls-key <pem>]
                (set BREWDOCS_TOKEN, or add keys via 'brewdocs keys', to require auth;
                 add --tls-cert/--tls-key for HTTPS, e.g. behind a custom domain)
  brewdocs keys add|list|revoke [--hosting <dir>] [--scope build,export] [--label <n>]
  brewdocs cloud org create|list|add-member|remove-member|delete [--hosting <dir>]   Orgs, members, private docs
  brewdocs cloud sites|stats <org> [--hosting <dir>]   Org-owned sites + analytics rollup
  brewdocs domains add|list|verify|remove [--hosting <dir>]   Custom domains + TLS verification
  brewdocs drafts list|extend|revoke [--hosting <dir>]   Manage private draft links
  brewdocs mcp [docmodel.json]   MCP stdio server over a docmodel.json artifact
                                 (tools: search_symbols, symbol_signature,
                                  deprecated_replacements; freshness-checked)
  brewdocs versions <source>
  brewdocs doctor <source> [--json] [--badge <file.svg>] [--min-coverage <pct>]
                  [--record] [--trend-svg <file.svg>]
  brewdocs diff <source> --from <tag> --to <tag> [--out <dir>] [--json]
  brewdocs changelog <source> --from <tag> --to <tag> [--file <changelog.md>] [--out <file>] [--json]
   brewdocs ci <source> --base <ref> [--post] [--min-coverage <pct>] [--fail-on-breaking] [--out <file>] [--json]
   brewdocs gate <source> --from <tag> [--to <tag>] [--out <dir>] [--acknowledge [note]] [--json]
   brewdocs audit <dir> [--json] [--min-score <n>] [--group a11y|seo|perf]   v3.0 site audit
   brewdocs registry publish|list|search|install|remove|gallery   v3.0 plugin registry + marketplace
   brewdocs drift <source> [--record] [--from <ref>] [--fail-on-drift]   v3.5 doc drift detection
   brewdocs federate add|list|remove|search|page [--store <dir>]   v3.5 cross-repo federated search

Commands:
    build <source>   Extract docs and write a single index.html (add --multi for symbol pages, --watch to rebuild)
                     every build also emits docmodel.json unless --no-docmodel
   build-all        Build every discovered version into <out>/<version>/ + root index
                     (add --workspaces for npm/yarn/pnpm monorepos: one site per
                      package under <out>/<pkg>/ + root index, cross-linked)
   export <source>  Static export: a fully self-contained site in <out> (add --markdown for docs.md, --json for docmodel.json)
   markdown <src>   Render the DocModel to Markdown/MDX (docs.md / docs.mdx);
                    --multi emits index.md + one symbols/<name>.md per symbol
   docmodel <src>   Write docmodel.json: the structured API knowledge (symbols,
                     resolved types, coverage, freshness stamp) for bots and tooling
                     (add --schema to also write the published JSON Schema)
   draft <src>      Scaffold JSDoc skeletons for undocumented exported symbols
                     (add --fix to write them into the source files)
   prove <src>      Typecheck every @example against the package
                     (add --strict to exit 1 on a failing example)
   harvest <src>    Propose @example snippets found in the README + test files
   init             Scaffold a brewdocs.yml in the current directory
  preview <src>    Build and serve the docs locally for a quick look
   deploy <source>  Deploy to a local hosting dir as <subdomain>.brewdocs.dev
                     (add --storage s3 with env vars, or brewdocs.yml, to deploy to S3/R2;
                      --org <name> namespaces as <org>--<sub>; --private [token] gates reads;
                      add --draft for a time-limited shareable ?token= preview link)
   serve            Start the local hosting server + web drop-in (/api/build, /api/export, /api/sites)
   versions <src>   List available versions (git tags, or package version)
   doctor <src>     Docs coverage report (+ badge, --json, --min-coverage gate,
                    --record trend history, --trend-svg sparkline);
                    add --workspaces for per-package reports + rollup score
  diff <src>       API diff between two git tags: --from <tag> --to <tag>
  changelog <src>  Auto-generated changelog section (markdown) from an API diff
   ci <src>         CI guardian: coverage + API diff vs --base <ref>;
                    --post comments on the PR (GITHUB_TOKEN); gate with
                    --min-coverage / --fail-on-breaking. Proves examples
                    by default (--no-prove to skip)
   gate <src>       Release gate: fail on breaking changes unless a migration
                    guide is generated (--out) or acknowledged (--acknowledge);
                    add --require-proven to also fail on examples that
                    no longer typecheck
    themes           List available themes
    locales          v3.0: list UI locales (en, de, es, fr, ja, id)
    keys             Manage per-user API keys (add / list / revoke)
    cloud            v2.5: orgs (create/list/add-member/remove-member/delete),
                      org sites + analytics rollup (cloud sites|stats <org>)
    domains          v2.5: custom domains (add --site, verify, list, remove)
    audit            v3.0: a11y + SEO + perf audit of a built site (<dir>, default dist)
                      --json, --min-score <n> gate, --group a11y|seo|perf
    registry         v3.0: plugin registry + marketplace
                      (publish <file> --name --version | list | search <q> |
                       install <name> --into <src> | remove | gallery [--out])
    drift            v3.5: doc drift detection — code changed, docs didn't
                      (<src> --record records a baseline in .brewdocs/drift.json;
                       --from <ref> compares against a git tag instead;
                       --fail-on-drift exits 1 for CI)
    federate         v3.5: cross-repo federated search
                      (add <name> <docmodel.json|dir> [--url <site>] | list |
                       remove <name> | search <query...> | page [--out])
    drafts           Manage private draft links (list / extend / revoke)
    mcp              MCP stdio server over docmodel.json for agent workflows
    help             Show this help

Options:
  -o, --out <dir>  Output/hosting directory (default: dist / ./hosting)
  -t, --theme     Theme name (coffee, ink, matcha, newsprint)
  --dark           Force dark mode by default
  -v, --version   Build a specific version (git tag)
  -n, --name      Subdomain name for deploy
    --multi         Emit one HTML page per exported symbol
    -w, --watch     Rebuild on source changes (build only)
     --plugins <a,b> v2.0: plugin modules (paths relative to <source>, or package names)
     --cache         v2.0: incremental extraction cache (.brewdocs/extract.json)
     --playground    v2.5: editable in-page example runners (Try it)
     --locale <code> v3.0: UI locale (brewdocs.yml 'locale:' is the default)

Config: a brewdocs.yml or brewdocs.json in the source dir sets theme, dark,
name, multi, storage (local | s3), plugins, cache, playground, locale, and
contentDir defaults. CLI flags override it. v2.0: '--theme' also accepts a
theme manifest (themes/<name>.yml with 'base:', 'vars:', and 'slots:'
partials); a 'content/' directory of .md/.mdx guide pages is published under
content/. v3.0: 'aliases:' (name → version redirect pages), 'eol:' (end-of-life
version list) and 'redirects:' (moved pages) ride along with build-all.

Search: press ⌘K / Ctrl+K on any generated page.
`);
}
