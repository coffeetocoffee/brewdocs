import * as fs from "node:fs";
import * as path from "node:path";
import { buildModel } from "./build.js";
import { gitShaOf } from "./git.js";
import { analyzeSymbols } from "./doctor.js";
import type { PackageInfo, RenderModel, Source, SymbolDoc } from "./types.js";

/** Versioned schema id so consumers can pin and evolve safely. */
export const DOCMODEL_SCHEMA = "brewdocs/docmodel@1";

/** Package metadata block, picked from package.json. */
export interface DocModelPackage {
  name?: string;
  version?: string;
  description?: string;
  license?: string;
  homepage?: string;
  repository?: string;
  keywords?: string[];
}

/** Coverage snapshot (doctor) embedded for machine consumers. */
export interface DocModelCoverage {
  score: number;
  totalSymbols: number;
  documentedSymbols: number;
  paramsTotal: number;
  paramsDocumented: number;
  returnsTotal: number;
  returnsDocumented: number;
  examplesTotal: number;
}

/**
 * The machine-readable DocModel artifact: the same structured API knowledge
 * every internal consumer (renderer, search, doctor, diff) reads, shipped as
 * a first-class JSON file with freshness metadata.
 */
export interface DocModelArtifact {
  schema: string;
  /** Build date (ISO 8601) — part of the freshness stamp. */
  generatedAt: string;
  generator: { name: string; version: string };
  package?: DocModelPackage;
  /**
   * The version this artifact describes (package version, or an explicit
   * override for versioned builds). Lets a consumer catch "docs from v2,
   * code is at v3" before trusting the content.
   */
  version?: string;
  source?: { gitSha?: string };
  coverage?: DocModelCoverage;
  title: string;
  description?: string;
  symbols: SymbolDoc[];
}

/** Overrides for deterministic output (tests) or injected metadata. */
export interface DocModelMeta {
  generatedAt?: string;
  gitSha?: string;
  generatorVersion?: string;
  /** Version stamp override (e.g. a git tag the model was extracted from). */
  version?: string;
}

function generatorVersion(): string {
  try {
    const pkg = JSON.parse(
      fs.readFileSync(new URL("../package.json", import.meta.url), "utf8"),
    ) as { version?: unknown };
    if (typeof pkg.version === "string") return pkg.version;
  } catch {
    /* not installed from a package layout */
  }
  return "unknown";
}

export { gitShaOf };

function packageBlock(pkg?: PackageInfo): DocModelPackage | undefined {
  if (!pkg) return undefined;
  const out: DocModelPackage = {
    name: pkg.name,
    version: pkg.version,
    description: pkg.description,
    license: pkg.license,
    homepage: pkg.homepage,
    repository: pkg.repository,
    keywords: pkg.keywords,
  };
  return out;
}

/**
 * Build the artifact object from a render model. Pure — no filesystem or
 * subprocess access; freshness metadata comes in via `meta`.
 */
export function docModelArtifact(
  model: RenderModel,
  meta: DocModelMeta = {},
): DocModelArtifact {
  let coverage: DocModelCoverage | undefined;
  try {
    const report = analyzeSymbols(model.title, model.symbols);
    coverage = {
      score: report.score,
      totalSymbols: report.totalSymbols,
      documentedSymbols: report.documentedSymbols,
      paramsTotal: report.paramsTotal,
      paramsDocumented: report.paramsDocumented,
      returnsTotal: report.returnsTotal,
      returnsDocumented: report.returnsDocumented,
      examplesTotal: report.examplesTotal,
    };
  } catch {
    /* coverage is additive; never fail the artifact on it */
  }

  return {
    schema: DOCMODEL_SCHEMA,
    generatedAt: meta.generatedAt ?? new Date().toISOString(),
    generator: {
      name: "brewdocs",
      version: meta.generatorVersion ?? generatorVersion(),
    },
    package: packageBlock(model.pkg),
    version: meta.version ?? model.pkg?.version,
    ...(meta.gitSha ? { source: { gitSha: meta.gitSha } } : {}),
    coverage,
    title: model.title,
    description: model.description,
    symbols: model.symbols,
  };
}

/** Render the artifact as stable, pretty JSON with a trailing newline. */
export function renderDocModelJson(
  model: RenderModel,
  meta: DocModelMeta = {},
): string {
  return JSON.stringify(docModelArtifact(model, meta), null, 2) + "\n";
}

/**
 * Build the DocModel for a source and write `docmodel.json` into `outDir`,
 * stamping the current git sha of the source repo when one exists. Returns
 * the written file path.
 */
export function buildDocModel(source: Source, outDir: string): string {
  const model = buildModel(source);
  const json = renderDocModelJson(model, { gitSha: gitShaOf(source.root) });
  fs.mkdirSync(outDir, { recursive: true });
  const outFile = path.join(outDir, "docmodel.json");
  fs.writeFileSync(outFile, json, "utf8");
  return outFile;
}
