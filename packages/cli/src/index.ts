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
  extractFromSource,
  extractVersion,
  gateDecision,
  insertChangelogSection,
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
  type BrewDocsConfig,
  type DoctorReport,
  type RenderOptions,
  type StorageAdapter,
  type SymbolDoc,
} from "@brewdocs/core";
import { createServer } from "./server.js";
import * as fs from "node:fs";
import * as crypto from "node:crypto";
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
    } else if (arg === "--badge" || arg === "--min-coverage") {
      i++; // value-taking flags the builder ignores, but their values must not become <source>
    } else if (arg.startsWith("--badge=") || arg.startsWith("--min-coverage=")) {
      // inline form, nothing to skip
    } else if (arg === "--multi") {
      multi = true;
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
      "usage: brewdocs build <source> [--out <dir>] [--theme <name>] [--dark] [--version <v>] [--name <subdomain>] [--multi] [--watch]",
    );
  }
  return { source, out, theme, dark, version, name, multi, watch };
}

function printDoctorReport(report: ReturnType<typeof diagnose>): void {
  console.log(`🩺 ${report.title} — docs coverage: ${report.score}%`);
  console.log(
    `   symbols: ${report.documentedSymbols}/${report.totalSymbols} documented · params: ${report.paramsDocumented}/${report.paramsTotal} · returns: ${report.returnsDocumented}/${report.returnsTotal} · examples: ${report.examplesTotal}`,
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

/** Merge CLI flags over brewdocs.yml defaults into render options. */function mergeOptions(args: BuildArgs, config: BrewDocsConfig): RenderOptions {
  return {
    theme: args.theme ?? config.theme,
    dark: args.dark || Boolean(config.dark),
    multiPage: args.multi || Boolean(config.multi),
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

    const decision = gateDecision({
      breakingCount: diff.breakingCount,
      guideGenerated,
      acknowledged,
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
      const files = await buildVersions(src, outDir, mergeOptions(args, config));
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
    const opts = mergeOptions(args, config);

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
        if (!/\.(ts|js|md|json)$/.test(file)) return;
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
      const outFile = await exportSite(src, outDir, mergeOptions(args, config));
      console.log(`📦 Exported static site -> ${outFile}`);
    } finally {
      cleanup();
    }
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
    const visibility =
      privateFlag || config.private ? "private" : "public";
    // --private without a value auto-generates a token; with a value, use it.
    const token =
      privateFlag && privateValue && !privateValue.startsWith("-")
        ? privateValue
        : privateFlag
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
        mergeOptions(args, config),
        storage,
        { org, visibility, token },
      );
      console.log(`🚀 Deployed -> ${result.url}`);
      if (result.visibility === "private") {
        console.log(
          `🔒 Private site. Access with token: ${token}\n   (?token=${token} or Authorization: Bearer ${token})`,
        );
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

  console.error(`Unknown command: ${command}`);
  printHelp();
  process.exitCode = 1;
}

function printHelp(): void {
  console.log(`BrewDocs — Brew your docs, serve them hot.

Usage:
  brewdocs build <source> [--out <dir>] [--theme <name>] [--dark] [--version <v>] [--multi] [--watch]
  brewdocs build-all <source> [--out <dir>] [--theme <name>] [--dark]
  brewdocs export <source> [--out <dir>] [--theme <name>] [--dark] [--multi]
  brewdocs deploy <source> [--name <sub>] [--out <hosting>] [--theme <name>] [--dark] [--storage s3]
                    [--org <name>] [--private [token]]
  brewdocs gallery [--src <dir>] [--out <dir>] [--theme <name>]
  brewdocs serve [--hosting <dir>] [--port 4000] [--storage s3]
               (set BREWDOCS_TOKEN to require auth on /api/build and /api/export)
  brewdocs versions <source>
  brewdocs doctor <source> [--json] [--badge <file.svg>] [--min-coverage <pct>]
                  [--record] [--trend-svg <file.svg>]
  brewdocs diff <source> --from <tag> --to <tag> [--out <dir>] [--json]
  brewdocs changelog <source> --from <tag> --to <tag> [--file <changelog.md>] [--out <file>] [--json]
  brewdocs ci <source> --base <ref> [--post] [--min-coverage <pct>] [--fail-on-breaking] [--out <file>] [--json]
  brewdocs gate <source> --from <tag> [--to <tag>] [--out <dir>] [--acknowledge [note]] [--json]

Commands:
  build <source>   Extract docs and write a single index.html (add --multi for symbol pages, --watch to rebuild)
  build-all        Build every discovered version into <out>/<version>/ + root index
  export <source>  Static export: a fully self-contained site in <out>
  deploy <source>  Deploy to a local hosting dir as <subdomain>.brewdocs.dev
                    (add --storage s3 with env vars, or brewdocs.yml, to deploy to S3/R2;
                     --org <name> namespaces as <org>--<sub>; --private [token] gates reads)
  serve            Start the local hosting server + web drop-in (/api/build, /api/export, /api/sites)
  versions <src>   List available versions (git tags, or package version)
  doctor <src>     Docs coverage report (+ badge, --json, --min-coverage gate,
                   --record trend history, --trend-svg sparkline)
  diff <src>       API diff between two git tags: --from <tag> --to <tag>
  changelog <src>  Auto-generated changelog section (markdown) from an API diff
  ci <src>         CI guardian: coverage + API diff vs --base <ref>;
                   --post comments on the PR (GITHUB_TOKEN); gate with
                   --min-coverage / --fail-on-breaking
  gate <src>       Release gate: fail on breaking changes unless a migration
                   guide is generated (--out) or acknowledged (--acknowledge)
  themes           List available themes
  help             Show this help

Options:
  -o, --out <dir>  Output/hosting directory (default: dist / ./hosting)
  -t, --theme     Theme name (coffee, ink, matcha, newsprint)
  --dark           Force dark mode by default
  -v, --version   Build a specific version (git tag)
  -n, --name      Subdomain name for deploy
  --multi         Emit one HTML page per exported symbol
  -w, --watch     Rebuild on source changes (build only)

Config: a brewdocs.yml or brewdocs.json in the source dir sets theme, dark,
name, multi, and storage (local | s3) defaults. CLI flags override it.

Search: press ⌘K / Ctrl+K on any generated page.
`);
}
