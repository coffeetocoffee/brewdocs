import {
  build,
  buildGallery,
  buildVersion,
  buildVersions,
  createStorage,
  deploySite,
  deriveSubdomain,
  discoverVersions,
  exportSite,
  listThemes,
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
}

function parseBuild(argv: string[]): BuildArgs {
  let source: string | undefined;
  let out = "dist";
  let theme: string | undefined;
  let dark = false;
  let version: string | undefined;
  let name: string | undefined;
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
    } else if (arg === "--dark") {
      dark = true;
    } else if (!arg.startsWith("-") && source === undefined) {
      source = arg;
    }
  }
  if (!source) {
    throw new Error(
      "usage: brewdocs build <source> [--out <dir>] [--theme <name>] [--dark] [--version <v>] [--name <subdomain>]",
    );
  }
  return { source, out, theme, dark, version, name };
}

function getFlag(argv: string[], flag: string): string | undefined {
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === flag) return argv[i + 1];
    if (argv[i].startsWith(`${flag}=`)) return argv[i].slice(flag.length + 1);
  }
  return undefined;
}

function env(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing required environment variable: ${name}`);
  return v;
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
    const { source, out, theme, dark } = parseBuild(rest);
    const outDir = path.resolve(process.cwd(), out);
    const files = await buildVersions(
      { root: path.resolve(process.cwd(), source) },
      outDir,
      { theme, dark },
    );
    console.log(`☕ Brewed ${files.length} version page(s) -> ${outDir}`);
    return;
  }

  if (command === "build") {
    const { source, out, theme, dark, version } = parseBuild(rest);
    const outDir = path.resolve(process.cwd(), out);
    const src = { root: path.resolve(process.cwd(), source) };
    const opts = { theme, dark };
    const outFile = version
      ? await buildVersion(src, outDir, version, opts)
      : build(src, outDir, opts);
    console.log(`☕ Brewed docs -> ${outFile}`);
    return;
  }

  if (command === "export") {
    const { source, out, theme, dark } = parseBuild(rest);
    const outDir = path.resolve(process.cwd(), out);
    const outFile = await exportSite(
      { root: path.resolve(process.cwd(), source) },
      outDir,
      { theme, dark },
    );
    console.log(`📦 Exported static site -> ${outFile}`);
    return;
  }

  if (command === "deploy") {
    const { source, out, theme, dark, name } = parseBuild(rest);
    const storageKind = getFlag(rest, "--storage") ?? "local";
    const src = { root: path.resolve(process.cwd(), source), name };
    const sub = name ?? deriveSubdomain(src);

    let storage: import("@brewdocs/core").StorageAdapter | undefined;
    if (storageKind === "s3") {
      storage = createStorage("s3", {
        s3: {
          bucket: env("BREWDOCS_S3_BUCKET"),
          region: env("BREWDOCS_S3_REGION"),
          endpoint: process.env.BREWDOCS_S3_ENDPOINT,
          accessKeyId: env("BREWDOCS_S3_ACCESS_KEY_ID"),
          secretAccessKey: env("BREWDOCS_S3_SECRET_ACCESS_KEY"),
          publicDomain: process.env.BREWDOCS_PUBLIC_DOMAIN,
        },
      });
    }

    const result = await deploySite(
      src,
      path.resolve(process.cwd(), out),
      sub,
      { theme, dark },
      storage,
    );
    console.log(`🚀 Deployed -> ${result.url}`);
    return;
  }

  if (command === "serve") {
    const hostingDir = path.resolve(
      process.cwd(),
      getFlag(rest, "--hosting") ?? "./hosting",
    );
    const port = Number(getFlag(rest, "--port") ?? "4000");
    const storageKind = getFlag(rest, "--storage") ?? "local";

    let storage: import("@brewdocs/core").StorageAdapter | undefined;
    if (storageKind === "s3") {
      storage = createStorage("s3", {
        s3: {
          bucket: env("BREWDOCS_S3_BUCKET"),
          region: env("BREWDOCS_S3_REGION"),
          endpoint: process.env.BREWDOCS_S3_ENDPOINT,
          accessKeyId: env("BREWDOCS_S3_ACCESS_KEY_ID"),
          secretAccessKey: env("BREWDOCS_S3_SECRET_ACCESS_KEY"),
          publicDomain: process.env.BREWDOCS_PUBLIC_DOMAIN,
        },
      });
    }

    const server = createServer(hostingDir, storage);
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
  brewdocs build <source> [--out <dir>] [--theme <name>] [--dark] [--version <v>]
  brewdocs build-all <source> [--out <dir>] [--theme <name>] [--dark]
  brewdocs export <source> [--out <dir>] [--theme <name>] [--dark]
  brewdocs deploy <source> [--name <sub>] [--out <hosting>] [--theme <name>] [--dark]
  brewdocs gallery [--src <dir>] [--out <dir>] [--theme <name>]
  brewdocs serve [--hosting <dir>] [--port 4000]
  brewdocs versions <source>

Commands:
  build <source>   Extract docs and write a single index.html (optionally one version)
  build-all        Build every discovered version into <out>/<version>/ + root index
  export <source>  Static export: a fully self-contained site in <out>
  deploy <source>  Deploy to a local hosting dir as <subdomain>.brewdocs.dev
                  (add --storage s3 with env vars to deploy to S3/R2)
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

Search: press ⌘K / Ctrl+K on any generated page.
`);
}
