# Contributing to BrewDocs

Thanks for brewing with us! This is a local-first monorepo (npm workspaces) and
we keep everything dependency-light on purpose.

## Getting started

```bash
npm install
npm test                 # 45 tests across extractors, render, search, deploy, API
npm run brewdocs build ./docs --theme ink --out docs-site
npm run brewdocs serve   # web drop-in at the printed URL
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

Publishing is a manual, deliberate step (not automated here):

```bash
cd packages/core && npm publish     # publish core first
cd ../cli      && npm publish        # then the CLI (depends on core)
```

Both packages ship TypeScript source and run via `tsx`, so no prebuild is needed.

## License

By contributing, you agree your contributions are licensed under the MIT License.
