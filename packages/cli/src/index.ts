import {
  build,
  buildGallery,
  buildVersion,
  buildVersions,
  buildMulti,
  createStorage,
  deploySite,
  deriveSubdomain,
  discoverVersions,
  exportSite,
  listThemes,
  loadConfig,
  resolveInput,
  type BrewDocsConfig,
  type RenderOptions,
  type StorageAdapter,
} from "@brewdocs/core";
import { createServer } from "./server.js";
import * as fs from "node:fs";
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

/** Merge CLI flags over brewdocs.yml defaults into render options. */
function mergeOptions(args: BuildArgs, config: BrewDocsConfig): RenderOptions {
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
    const sub = args.name ?? config.name ?? resolved.name ?? deriveSubdomain(src);
    const storage = buildStorage(storageKind, config);

    try {
      const result = await deploySite(
        src,
        path.resolve(process.cwd(), args.out),
        sub,
        mergeOptions(args, config),
        storage,
      );
      console.log(`🚀 Deployed -> ${result.url}`);
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
  brewdocs gallery [--src <dir>] [--out <dir>] [--theme <name>]
  brewdocs serve [--hosting <dir>] [--port 4000] [--storage s3]
               (set BREWDOCS_TOKEN to require auth on /api/build and /api/export)
  brewdocs versions <source>

Commands:
  build <source>   Extract docs and write a single index.html (add --multi for symbol pages, --watch to rebuild)
  build-all        Build every discovered version into <out>/<version>/ + root index
  export <source>  Static export: a fully self-contained site in <out>
  deploy <source>  Deploy to a local hosting dir as <subdomain>.brewdocs.dev
                   (add --storage s3 with env vars, or brewdocs.yml, to deploy to S3/R2)
  serve            Start the local hosting server + web drop-in (/api/build, /api/export, /api/sites)
  versions <src>   List available versions (git tags, or package version)
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
