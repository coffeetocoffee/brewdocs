/**
 * Core data contracts for the BrewDocs extraction pipeline.
 *
 * Pipeline shape (Phase 0 baseline):
 *   Source  ->  ExtractResult  ->  RenderModel  ->  HTML
 *
 * Later phases extend these interfaces (symbols from JSDoc/TSDoc, versions,
 * search index) without changing the overall flow.
 */

/** Where docs are brewed from. */
export interface Source {
  /** Absolute or relative path to a local repo/package directory. */
  root: string;
  /** Optional explicit name; falls back to package.json name or dir basename. */
  name?: string;
}

/** A documented parameter of an exported symbol. */
export interface ParamDoc {
  name: string;
  type?: string;
  description?: string;
  optional?: boolean;
  default?: string;
}

/** A documented exported symbol (extracted in Phase 1). */
export interface SymbolDoc {
  name: string;
  kind: "function" | "class" | "interface" | "type" | "constant" | "unknown";
  /** Source text of the declaration (signature-ish). */
  signature?: string;
  description?: string;
  params: ParamDoc[];
  returns?: { type?: string; description?: string };
  examples: string[];
  deprecated?: string | boolean;
  sourceFile?: string;
}

/** Key/value pairs pulled from README frontmatter. */
export type Frontmatter = Record<string, string>;

/** A README section delimited by a heading. */
export interface SectionDoc {
  id: string;
  title: string;
  level: number;
  html: string;
}

/** Raw README parse result. */
export interface ReadmeResult {
  frontmatter: Frontmatter;
  sections: SectionDoc[];
  /** Full README rendered to HTML. */
  html: string;
}

/** Structured package metadata (Phase 1). */
export interface PackageInfo {
  name?: string;
  version?: string;
  description?: string;
  license?: string;
  homepage?: string;
  repository?: string;
  keywords?: string[];
  bin?: Record<string, string> | string;
  exports?: unknown;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  scripts?: Record<string, string>;
}

/** Raw extracted data, before rendering. */
export interface ExtractResult {
  title: string;
  description?: string;
  /** Parsed README (undefined if no README present). */
  readme?: ReadmeResult;
  /** Structured package.json info. */
  pkg?: PackageInfo;
  /** Raw package.json (empty object if none). */
  metadata: Record<string, unknown>;
  /** Exported symbols. */
  symbols: SymbolDoc[];
}

/** The structured model the renderer consumes. */
export interface RenderModel {
  title: string;
  description?: string;
  frontmatter: Frontmatter;
  sections: SectionDoc[];
  /** Full README HTML, used as fallback when sections are empty. */
  readmeHtml?: string;
  metadata: Record<string, unknown>;
  pkg?: PackageInfo;
  symbols: SymbolDoc[];
}
