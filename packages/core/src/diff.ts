import type { SymbolDoc } from "./types.js";

export type ChangeKind =
  | "added"
  | "removed"
  | "signature-changed"
  | "docs-changed"
  | "deprecated"
  | "undeprecated"
  | "kind-changed";

export interface SymbolChange {
  name: string;
  changes: ChangeKind[];
  /** breaking = removed, renamed-away or signature changed */
  breaking: boolean;
  from?: SymbolDoc;
  to?: SymbolDoc;
}

export interface VersionDiff {
  fromVersion: string;
  toVersion: string;
  added: SymbolChange[];
  removed: SymbolChange[];
  changed: SymbolChange[];
  /** removed + signature-changed + kind-changed counts */
  breakingCount: number;
  summary: string;
}

function normalizeSig(s: SymbolDoc): string {
  return (s.signature ?? "").replace(/\s+/g, " ").trim();
}

/**
 * Semantic fingerprint of a callable signature: alias-unwrapped param and
 * return types only. Two signatures with the same resolved types are
 * compatible even when the source text differs (`UserId` vs `string`,
 * formatting, param renames). Undefined when unresolved types are missing,
 * so diffing falls back to the textual comparison.
 */
function resolvedSigFingerprint(s: SymbolDoc): string | undefined {
  if (!s.resolvedParams) return undefined;
  const parts = [...s.resolvedParams];
  if (s.resolvedReturn) parts.push(s.resolvedReturn);
  return parts.join("|");
}

/** Semantic members fingerprint for classes/interfaces (Shape A2). */
function membersFingerprint(s: SymbolDoc): string {
  return JSON.stringify(
    (s.members ?? []).map((m) => [m.name, m.kind, m.signature ?? ""]),
  );
}

function docsFingerprint(s: SymbolDoc): string {
  return JSON.stringify({
    d: s.description ?? "",
    p: s.params.map((p) => [p.name, p.description ?? "", p.default ?? ""]),
    r: [s.returns?.type ?? "", s.returns?.description ?? ""],
    e: s.examples,
    t: s.throws ?? [],
    see: s.see ?? [],
    m: (s.members ?? []).map((m) => [m.name, m.description ?? ""]),
  });
}

export function describeChange(kind: ChangeKind, c: SymbolChange): string {
  switch (kind) {
    case "removed":
      return "removed";
    case "kind-changed":
      return `kind changed ${c.from?.kind ?? "?"} -> ${c.to?.kind ?? "?"}`;
    case "signature-changed":
      return "signature changed";
    case "deprecated":
      return "deprecated";
    case "undeprecated":
      return "deprecation removed";
    case "added":
      return "added";
    default:
      return "docs changed";
  }
}

/**
 * Diff two extracted symbol sets into a structured migration report.
 * `from`/`to` are the older and newer extractions respectively.
 */
export function diffSymbols(
  fromVersion: string,
  from: SymbolDoc[],
  toVersion: string,
  to: SymbolDoc[],
): VersionDiff {
  const fromByName = new Map(from.map((s) => [s.name, s]));
  const toByName = new Map(to.map((s) => [s.name, s]));

  const added: SymbolChange[] = [];
  const removed: SymbolChange[] = [];
  const changed: SymbolChange[] = [];

  for (const [name, sym] of toByName) {
    if (!fromByName.has(name)) {
      added.push({ name, changes: ["added"], breaking: false, to: sym });
      continue;
    }
    const old = fromByName.get(name)!;
    const changes: ChangeKind[] = [];

    if (old.kind !== sym.kind) changes.push("kind-changed");
    // Prefer the alias-unwrapped fingerprint; textual comparison would flag
    // `f(x: UserId)` -> `f(x: string)` as breaking when it is not.
    const oldFp = resolvedSigFingerprint(old);
    const newFp = resolvedSigFingerprint(sym);
    const sigChanged =
      oldFp !== undefined && newFp !== undefined
        ? oldFp !== newFp
        : normalizeSig(old) !== normalizeSig(sym);
    if (sigChanged) changes.push("signature-changed");
    if (membersBreaking(old, sym)) changes.push("signature-changed");
    if (docsFingerprint(old) !== docsFingerprint(sym)) changes.push("docs-changed");

    const wasDeprecated = Boolean(old.deprecated);
    const isDeprecated = Boolean(sym.deprecated);
    if (isDeprecated && !wasDeprecated) changes.push("deprecated");
    if (!isDeprecated && wasDeprecated) changes.push("undeprecated");

    if (changes.length > 0) {
      changed.push({ name, changes, breaking: false, from: old, to: sym });
    }
  }

  for (const [name, sym] of fromByName) {
    if (!toByName.has(name)) {
      removed.push({ name, changes: ["removed"], breaking: true, from: sym });
    }
  }

  for (const c of changed) {
    c.breaking =
      c.changes.includes("signature-changed") ||
      c.changes.includes("kind-changed") ||
      c.changes.includes("removed");
  }

  const breakingCount =
    removed.length + changed.filter((c) => c.breaking).length;

  const sortFn = (a: SymbolChange, b: SymbolChange) => a.name.localeCompare(b.name);
  added.sort(sortFn);
  removed.sort(sortFn);
  changed.sort(sortFn);

  const parts: string[] = [];
  if (added.length) parts.push(`${added.length} added`);
  if (removed.length) parts.push(`${removed.length} removed`);
  if (changed.length) parts.push(`${changed.length} changed`);
  const summary =
    parts.length === 0
      ? "No API changes detected."
      : `${parts.join(", ")} — ${breakingCount} breaking.`;

  return {
    fromVersion,
    toVersion,
    added,
    removed,
    changed,
    breakingCount,
    summary,
  };
}

const escapeHtml = (s: string): string =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** Interface members grow breaking; class members grow non-breaking. */
function membersBreaking(from: SymbolDoc, to: SymbolDoc): boolean {
  if (!from.members || !to.members) return false;
  const norm = (s: string) => s.replace(/\s+/g, " ").trim();
  const toByName = new Map(to.members.map((m) => [m.name, m]));
  for (const m of from.members) {
    const next = toByName.get(m.name);
    if (!next) return true;
    if (norm(m.signature ?? "") !== norm(next.signature ?? "")) return true;
  }
  if (from.kind === "interface") {
    return to.members.some((m) => !from.members!.some((o) => o.name === m.name));
  }
  return false;
}

/** Strip a leading "v"/"V" so tags like "v1.2.0" render as "v1.2.0", not "vv1.2.0". */
export function versionLabel(version: string): string {
  return version.replace(/^v/i, "");
}

const sigBlock = (s: SymbolDoc | undefined): string =>
  s?.signature ? `<pre class="sig">${escapeHtml(s.signature)}</pre>` : "";

const note = (c: SymbolChange): string =>
  c.changes.map((k) => describeChange(k, c)).map(escapeHtml).join(" · ");

/** Render a VersionDiff as a standalone themed HTML page. */
export function renderDiffHtml(diff: VersionDiff, title: string): string {
  const breakingTone = diff.breakingCount > 0 ? "#cb2431" : "#4c1";

  const section = (
    heading: string,
    items: SymbolChange[],
    emptyText: string,
    cls: string,
  ): string =>
    `<section><h2>${heading} <span class="count">${items.length}</span></h2>${
      items.length === 0
        ? `<p class="empty">${emptyText}</p>`
        : `<ul class="changes">${items
            .map(
              (c) =>
                `<li class="${cls}${c.breaking ? " breaking" : ""}"><code>${escapeHtml(c.name)}</code> <span class="note">${note(c)}</span>${sigBlock(c.from)}${
                  c.to?.signature && c.from?.signature && c.changes.includes("signature-changed")
                    ? sigBlock(c.to)
                    : ""
                }${c.to && c.changes.includes("signature-changed") && !c.from?.signature ? sigBlock(c.to) : ""}</li>`,
            )
            .join("")}</ul>`
    }</section>`;

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)} — API diff v${escapeHtml(versionLabel(diff.fromVersion))} → v${escapeHtml(versionLabel(diff.toVersion))}</title>
<style>
:root { --bg:#faf7f2; --ink:#2b2118; --muted:#7a6a58; --accent:#b5651d; --card:#fff; --line:#e8ddcc; --code-bg:#f0e7d8; }
* { box-sizing:border-box }
body { font-family:system-ui,sans-serif; background:var(--bg); color:var(--ink); max-width:860px; margin:0 auto; padding:2rem 1rem 4rem; line-height:1.55 }
header h1 { margin:0 0 .25rem; font-size:1.6rem }
header .sub { color:var(--muted); margin-bottom:1rem }
.badge { display:inline-block; padding:.1rem .6rem; border-radius:999px; color:#fff; font-weight:600; font-size:.85rem; background:${breakingTone} }
section { background:var(--card); border:1px solid var(--line); border-radius:8px; padding:1rem 1.25rem; margin:1rem 0 }
h2 { font-size:1.05rem; margin:.25rem 0 .75rem }
.count { background:var(--code-bg); border-radius:999px; padding:0 .5rem; font-size:.8rem; color:var(--muted) }
ul.changes { list-style:none; margin:0; padding:0 }
ul.changes li { padding:.5rem 0; border-top:1px solid var(--line) }
ul.changes li:first-child { border-top:0 }
li.added code::before { content:"+ "; color:#4c1; font-weight:700 }
li.removed code::before { content:"− "; color:#cb2431; font-weight:700 }
li.changed code::before { content:"~ "; color:var(--accent); font-weight:700 }
li.breaking { background:#fff5f5; margin:0 -0.75rem; padding:.5rem .75rem; border-radius:6px }
li.breaking code::after { content:" BREAKING"; color:#cb2431; font-size:.7rem; font-weight:700; margin-left:.5rem; vertical-align:middle }
code { font-family:ui-monospace,Menlo,Consolas,monospace; font-size:.92rem }
.note { color:var(--muted); font-size:.85rem; margin-left:.5rem }
pre.sig { background:var(--code-bg); padding:.5rem .75rem; border-radius:6px; overflow-x:auto; margin:.4rem 0 0; font-size:.85rem }
.empty { color:var(--muted); font-style:italic; margin:0 }
footer { color:var(--muted); font-size:.85rem; margin-top:2rem }
</style>
</head>
<body>
<header>
  <h1>${escapeHtml(title)} <span class="badge">${diff.breakingCount} breaking</span></h1>
  <p class="sub">API diff: <code>v${escapeHtml(versionLabel(diff.fromVersion))}</code> → <code>v${escapeHtml(versionLabel(diff.toVersion))}</code> — ${escapeHtml(diff.summary)}</p>
</header>
${section("Added", diff.added, "Nothing added.", "added")}
${section("Removed", diff.removed, "Nothing removed.", "removed")}
${section("Changed", diff.changed, "Nothing changed.", "changed")}
<footer>Generated by <a href="https://github.com/coffeetocoffee/brewdocs">BrewDocs</a> · <code>brewdocs diff</code></footer>
</body>
</html>`;
}
