# Repository knowledge base

This directory is the team's memory for this repo. It exists because the
project had plenty of documentation and still lost knowledge: the README's test
count drifted, the roadmap was gitignored, and the reason a security check was
written a particular way lived only in the head of whoever wrote it.

Two halves, and the split matters:

| | Who owns it | Can it be wrong? |
| --- | --- | --- |
| `facts/*.json` | **Humans.** Judgement, rationale, severity. | Yes — reviewed in PRs like code. |
| `PROJECT_MAP.md`, `agents-context.json` | **Generated.** Never edit by hand. | No — `npm run map:check` fails when stale. |

## Read this first

- **A teammate, joining:** [`PROJECT_MAP.md`](./PROJECT_MAP.md). One screen: the shape, the
  trust boundaries, where state lives, what the project deliberately does not do,
  and every known weakness with its current status.
- **An AI agent, reloading context:** [`agents-context.json`](./agents-context.json).
  The same facts in machine-readable form, so an agent does not have to re-read
  16k lines of source to know the layout.

## The one rule

**Numbers are never typed by hand.** Test counts, file/LOC totals and the HTTP
surface table are parsed from the source tree on every generation. If you find
yourself writing a count into prose, put it in a `facts/` file as data instead,
or let the generator derive it.

```bash
npm run map        # regenerate the two generated views
npm run map:check  # exit 1 if they are stale (this is what CI runs)
npm run gate       # security invariants + every fixed finding's own check
npm run verify     # typecheck + map:check + gate + test — run before a release
```

## What lives where

| File | Holds |
| --- | --- |
| `facts/project.json` | What this is, who it is for, the threat model in one paragraph |
| `facts/invariants.json` | The rules a change must not break, each with *why* and what enforces it |
| `facts/findings.json` | Known weaknesses: severity, status, and the check that proves the status |
| `facts/decisions.json` | Choices that look wrong until you know the constraint (D-1 … D-6) |
| `facts/state.json` | Every JSON file the tool writes and which command writes it |
| `facts/boundaries.json` | Non-goals, so review comments can point here instead of re-arguing |
| `facts/working.json` | Pipeline, conventions, and the commands used day to day |

## Why findings have a status the gate can check

A markdown table saying "fixed" is a claim. A claim nobody tests rots — this
repo shipped an XSS with 311 green tests, and a path-traversal test that passed
for the wrong reason (Node's URL normalizer, not the code).

So each finding in `facts/findings.json` marked `fixed` must name either
`checkedBy` (a static invariant check the gate already runs) or `verify` (a
command the gate executes). If that check starts failing, the gate fails and the
entry is proven wrong. To see it work, revert the quote escaping in
`packages/core/src/markdown.ts` and run `npm run gate` — finding #3 and INV-4
both go red.

Findings marked `open` carry a `fixHint` instead: the specific file and approach,
so picking one up does not require re-deriving the analysis.

## Adding to it

- **New endpoint or a changed guard?** The trust-boundary table regenerates
  itself from `server.ts`. If the change breaks an invariant, update
  `facts/invariants.json` in the same commit.
- **New security-relevant rule?** Add it to `facts/invariants.json` with a
  `why`, then add a check to `scripts/gate.mjs` and reference it by id.
- **Fixed something from `findings.json`?** Flip `status` to `fixed`, set
  `checkedBy`/`verify`, and run `npm run map`.
- **Made an architectural trade-off?** Add a `decisions.json` entry. The point is
  to stop the next person from "fixing" a deliberate choice.
