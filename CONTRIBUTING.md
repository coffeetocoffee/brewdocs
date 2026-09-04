# Contributing to BrewDocs

Thanks for brewing with us! This is a local-first monorepo (npm workspaces) and
we keep everything dependency-light on purpose.

## Getting started

```bash
npm install
npm test                 # 45 tests across extractors, render, search, deploy, API
npm run brewdocs -- build ./docs --theme ink --out docs-site
npm run brewdocs -- serve   # web drop-in at the printed URL
```

## Layout

- `packages/core` — `@brewdocs/core`: extractors, markdown + highlighter, themes,
  search index, versioning, deploy/storage adapters, gallery.
- `packages/cli` — `@brewdocs/cli`: the command line interface, local hosting
  server, and web drop-in.

The core pipeline is a pure flow: `Source → ExtractResult → RenderModel → HTML`.

## Conventions

- TypeScript everywhere; no build step for local dev (run via `tsx`).
- Keep the **local** backend zero-dependency. New runtime deps must be lazy /
  optional (the S3 adapter loads `@aws-sdk/client-s3` only when selected).
- Add a test for any new extractor, renderer, or deploy behavior. Run `npm test`
  before opening a PR.

## Publishing

Releases ship both packages to npm via the `Publish` workflow:

1. Bump `version` in the root `package.json`, `packages/core/package.json`,
   and `packages/cli/package.json` (keep all three in sync; the CLI depends
   on the same version of core).
2. Commit, then tag: `git tag v0.1.0 && git push origin v0.1.0`.
3. The workflow runs tests, then publishes `@brewdocs/core` first and
   `@brewdocs/cli` second (order matters — the CLI depends on core).

It needs a `NPM_TOKEN` repo secret with publish access to the `@brewdocs`
scope. Both packages ship TypeScript source and run via `tsx`, so no
prebuild is needed.

## License

By contributing, you agree your contributions are licensed under the MIT License.
