export * from "./types.js";
export { extractFromSource } from "./extract.js";
export { extractReadme } from "./extractors/readme.js";
export { extractPackage } from "./extractors/package.js";
export { extractExports } from "./extractors/exports.js";
export { markdownToHtml } from "./markdown.js";
export { renderToHtml, renderToHtmlMulti, type RenderOptions, type VersionLink, type RenderedPage } from "./render.js";
export { build, buildModel, buildVersion, buildVersions, buildMulti, extractVersion } from "./build.js";
export { buildGallery, type GalleryEntry } from "./gallery.js";
export {
  type StorageAdapter,
  type StorageKind,
  LocalStorageAdapter,
  S3StorageAdapter,
  createStorage,
} from "./deploy/storage.js";
export {
  exportSite,
  deploySite,
  deriveSubdomain,
  type DeployResult,
} from "./deploy.js";
export { buildSearchIndex, type SearchDoc } from "./search.js";
export { discoverVersions, readPackageVersion } from "./versions.js";
export {
  resolveInput,
  type ResolvedSource,
} from "./resolve.js";
export { THEMES, DEFAULT_THEME, getTheme, listThemes } from "./themes.js";
export { loadConfig, type BrewDocsConfig } from "./config.js";
export {
  analyzeSymbols,
  diagnose,
  badgeSvg,
  type DoctorReport,
  type DoctorIssue,
} from "./doctor.js";
export {
  diffSymbols,
  renderDiffHtml,
  describeChange,
  versionLabel,
  type VersionDiff,
  type SymbolChange,
} from "./diff.js";
export {
  CI_COMMENT_MARKER,
  loadCoverageHistory,
  recordCoverage,
  coverageFilePath,
  sparklineUnicode,
  sparklineSvg,
  breakingChangesOf,
  renderChangelogMarkdown,
  insertChangelogSection,
  renderCiMarkdown,
  gateDecision,
  readAcknowledgment,
  writeAcknowledgment,
  postGitHubComment,
  type CoverageRecord,
  type CiReportInput,
  type GateInput,
  type GateDecision,
  type GitHubCommentTarget,
} from "./ci.js";
