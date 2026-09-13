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
  combineSubdomain,
  setDraftExpiry,
  draftExpired,
  type DeployResult,
  type DeploySiteOptions,
  type Visibility,
} from "./deploy.js";
export { buildSearchIndex, type SearchDoc } from "./search.js";
export {
  renderToMarkdown,
  buildMarkdown,
  buildMarkdownMulti,
  renderToMarkdownMulti,
  type MarkdownOptions,
  type MarkdownPage,
  type FreshnessStamp,
} from "./markdown-export.js";
export { renderSymbolText, symbolSlug } from "./doc-text.js";
export {
  resolveReplacements,
  replacementHint,
} from "./replacements.js";
export { discoverVersions, readPackageVersion } from "./versions.js";
export { gitShaOf } from "./git.js";
export {
  buildDocModel,
  docModelArtifact,
  renderDocModelJson,
  DOCMODEL_SCHEMA,
  type DocModelArtifact,
  type DocModelMeta,
  type DocModelCoverage,
  type DocModelPackage,
} from "./docmodel.js";
export {
  DOCMODEL_SCHEMA_ID,
  DOCMODEL_SCHEMA_OBJECT,
  docModelSchemaJson,
} from "./schema.js";
export {
  resolveInput,
  type ResolvedSource,
} from "./resolve.js";
export {
  detectWorkspaces,
  crossPackageLinks,
  externalLinksFor,
  rollupCoverage,
  buildWorkspaces,
  type WorkspacePackage,
  type WorkspaceRollup,
} from "./workspaces.js";
export {
  runMcpServer,
  loadDocModel,
  validateAgainstSchema,
  checkFreshness,
  searchSymbols,
  symbolSignature,
  deprecatedReplacements,
  MCP_TOOLS,
  type McpToolName,
} from "./mcp.js";
export {
  buildDrafts,
  applyDrafts,
  jsdocStub,
  type DraftProposal,
} from "./draft.js";
export {
  proveSource,
  proveSummary,
  type ProveResult,
} from "./prove.js";
export {
  harvestExamples,
  type HarvestProposal,
} from "./harvest.js";
export { THEMES, DEFAULT_THEME, getTheme, listThemes } from "./themes.js";
export { loadConfig, type BrewDocsConfig } from "./config.js";
export {
  type BrewDocsPlugin,
  type LanguageAdapter,
  type AdapterContext,
  type ThemeContribution,
  type ThemeSlotPartials,
  BUILTIN_PLUGINS,
  loadPlugin,
  loadPluginAsync,
  loadPlugins,
  collectAdapters,
  runAdapters,
  applyOnExtract,
  applyOnRender,
  mergePluginThemes,
} from "./plugins.js";
export {
  fingerprintSource,
  extractCached,
  clearCache,
  cacheFile,
  type CachedExtractOptions,
} from "./cache.js";
export {
  loadContent,
  loadNav,
  parseNavYaml,
  transformMdx,
  renderContentSource,
} from "./content.js";
export {
  loadThemeManifest,
  resolveThemeRef,
  manifestSlots,
  applyManifest,
  themeFromRef,
  type Slots,
  type SlotName,
} from "./theme-manifest.js";
export { pythonAdapter, resetPythonProbe } from "./extractors/python.js";
export { goAdapter } from "./extractors/go.js";
export { openApiAdapter } from "./extractors/openapi.js";
export { graphqlAdapter } from "./extractors/graphql.js";
export {
  addOrgMember,
  aggregateOrgStats,
  canAccessOrg,
  createOrg,
  deleteOrg,
  getOrg,
  hashKey as hashCloudKey,
  listOrgSites,
  listOrgs,
  normalizeKeyHash,
  orgOfSite,
  recordOrgSite,
  removeOrgMember,
  type CloudStore,
  type OrgMember,
  type OrgRecord,
  type OrgRole,
} from "./cloud.js";
export {
  addDomain,
  getDomain,
  listDomains,
  loadDomains,
  readTlsFile,
  removeDomain,
  verifyDomain,
  wellKnownPath,
  wellKnownToken,
  type DomainRecord,
  type DomainsStore,
} from "./domains.js";
export {
  renderContentPages,
  contentIndexToc,
  contentIndexSection,
} from "./render.js";
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
