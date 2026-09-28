# Contributing to BrewDocs

Thanks for brewing with us! This is a local-first monorepo (npm workspaces) and
we keep everything dependency-light on purpose.

## Getting started

```bash
npm install
npm test                 # full suite (typecheck + map + gate + tests via `npm run verify`)
npm run verify           # the gate CI runs: typecheck → map:check → security gate → tests
npm run brewdocs -- build ./docs --theme ink --out docs-site
npm run brewdocs -- serve   # web drop-in at the printed URL
```

## Layout

- `packages/core` — `@brewdocs/core`: extractors, markdown + highlighter, themes,
  search index, versioning, deploy/storage adapters, gallery.
- `packages/cli` — `@brewdocs/cli`: the command line interface, local hosting
  server, and web drop-in.
- `packages/plugin-sdk` — `@brewdocs/plugin-sdk`: adapter/hook contracts.

The core pipeline is a pure flow: `Source → ExtractResult → RenderModel → HTML`.

## Conventions

- TypeScript everywhere; no build step for local dev (run via `tsx`).
- Keep the **local** backend zero-dependency. New runtime deps must be lazy /
  optional (the S3 adapter loads `@aws-sdk/client-s3` only when selected).
- Add a test for any new extractor, renderer, or deploy behavior. Run `npm run
  verify` before opening a PR.
- **No linter, by decision.** The gates are `tsc` (typecheck) and the security
  gate + invariant suite in `scripts/gate.mjs`; there is deliberately no ESLint /
  Biome / Prettier. Formatting consistency comes from the house style, and a
  linter would be a dependency the project has chosen not to carry (see the
  `docs/map/facts/decisions.json` zero-dependency entries). Don't add one without
  raising it first.
- **Node**: `engines` is `>=18` (the consumer floor), and dev/CI run Node 24 with
  `@types/node` at `^24`. The code sticks to long-stable `node:` APIs, so the
  floor and the dev version can legitimately differ — but bump both together if
  you ever reach for a version-specific API.
- **`docs/map/` is generated.** `npm run map` regenerates; `npm run map:check`
  fails when it is stale (it runs in CI). Note this guards the *generated views*
  only — the hand-written prose in `facts/*.json` is copied through faithfully and
  can go stale silently. Read those files when you touch the pipeline.

## Publishing

Releases ship the workspace packages to npm via the `Publish` workflow:

1. Bump `version` in **all four** `package.json` files — root, `packages/core`,
   `packages/cli`, and `packages/plugin-sdk` — keeping them in sync (the CLI
   depends on the same version of core; the root is `private` but tracked so it
   can't drift — that drift was finding #14). Refresh the lockfile with
   `npm install`. There is no changeset tooling: this is a deliberate manual
   ritual, and it is why the version lives in four places.
2. Commit, then tag: `git tag vX.Y.Z && git push origin vX.Y.Z`.
3. The workflow runs `npm run verify` (typecheck + map + gate + tests) and a
   smoke build, then publishes in dependency order (core before cli).

Tags drive publishing (`v*`), so a tag is a release. It needs an `NPM_TOKEN`
repo secret with publish access to the `@brewdocs` scope. The packages ship
TypeScript source and run via `tsx`, so no prebuild is needed.

## License

By contributing, you agree your contributions are licensed under the MIT License.
