import * as fs from "node:fs";
import * as path from "node:path";
import { describeChange, versionLabel, type SymbolChange, type VersionDiff } from "./diff.js";
import { colorFor, type DoctorReport } from "./doctor.js";
import { replacementHint } from "./replacements.js";

/**
 * CI guardian — Direction B. Everything here turns doctor + diff output into
 * recurring CI value: coverage history + sparklines, auto changelog sections,
 * a release gate, and the GitHub PR comment.
 */

export interface CoverageRecord {
  /** Package version (or "dev") the build was recorded for. */
  version: string;
  /** 0-100 doctor score. */
  score: number;
  /** ISO timestamp of the build. */
  timestamp: string;
  totalSymbols: number;
  documentedSymbols: number;
}

export const CI_COMMENT_MARKER = "<!-- brewdocs:ci -->";

const MAX_HISTORY = 100;

export function coverageFilePath(root: string): string {
  return path.join(root, ".brewdocs", "coverage.json");
}

/** Load the coverage history for a source root ([] when none recorded yet). */
export function loadCoverageHistory(root: string): CoverageRecord[] {
  try {
    const parsed = JSON.parse(fs.readFileSync(coverageFilePath(root), "utf8"));
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

/**
 * Append a build to the coverage history at `<root>/.brewdocs/coverage.json`.
 * One record per version: re-recording a version replaces its previous
 * entry. History is capped at MAX_HISTORY (oldest entries dropped) so the
 * file stays commit-friendly.
 */
export function recordCoverage(
  root: string,
  report: DoctorReport,
  version: string,
): CoverageRecord[] {
  const history = loadCoverageHistory(root).filter(
    (r) => r.version !== version,
  );
  history.push({
    version,
    score: report.score,
    timestamp: new Date().toISOString(),
    totalSymbols: report.totalSymbols,
    documentedSymbols: report.documentedSymbols,
  });
  const trimmed = history.slice(-MAX_HISTORY);
  const file = coverageFilePath(root);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(trimmed, null, 2) + "\n", "utf8");
  return trimmed;
}

const BLOCKS = ["▁", "▂", "▃", "▄", "▅", "▆", "▇", "█"];

/** Terminal sparkline over an absolute 0-100 scale (shape-honest). */
export function sparklineUnicode(scores: number[]): string {
  if (scores.length === 0) return "";
  const step = 100 / BLOCKS.length;
  return scores
    .map((s) =>
      BLOCKS[Math.min(BLOCKS.length - 1, Math.max(0, Math.floor(s / step)))],
    )
    .join("");
}

/** Inline SVG sparkline (polyline) colored by the latest score. */
export function sparklineSvg(
  scores: number[],
  width = 120,
  height = 28,
): string {
  if (scores.length === 0) return "";
  const stepX = scores.length > 1 ? width / (scores.length - 1) : width;
  const y = (s: number) =>
    height - 2 - (Math.max(0, Math.min(100, s)) / 100) * (height - 4);
  const points = scores
    .map((s, i) => `${(i * stepX).toFixed(1)},${y(s).toFixed(1)}`)
    .join(" ");
  const last = scores[scores.length - 1];
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img" aria-label="docs coverage trend"><polyline fill="none" stroke="${colorFor(last)}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" points="${points}"/></svg>`;
}

export function breakingChangesOf(diff: VersionDiff): SymbolChange[] {
  return [...diff.removed, ...diff.changed.filter((c) => c.breaking)];
}

function label(c: SymbolChange): string {
  return c.changes.map((k) => describeChange(k, c)).join(", ");
}

function sigLines(c: SymbolChange): string[] {
  const out: string[] = [];
  if (c.from?.signature) out.push(`  - old: \`${c.from.signature}\``);
  if (c.to?.signature) out.push(`  - new: \`${c.to.signature}\``);
  return out;
}

function migrationHint(c: SymbolChange): string {
  const parts: string[] = [];
  if (c.changes.includes("removed")) {
    // Direction C: when the removed symbol pointed at a successor via
    // `@see`/`@deprecated`, say "use X instead" instead of a generic nudge.
    const hint = replacementHint(c.from?.replacements);
    parts.push(
      hint
        ? `was removed — ${hint}`
        : "was removed — update usages to its replacement",
    );
  }
  if (c.changes.includes("kind-changed")) {
    parts.push(
      `is now a ${c.to?.kind ?? "?"}, not a ${c.from?.kind ?? "?"} — adjust call sites`,
    );
  }
  if (c.changes.includes("signature-changed")) {
    parts.push("changed signature — update call sites to the new arguments");
  }
  if (c.changes.includes("deprecated")) {
    const hint = replacementHint(c.to?.replacements);
    if (hint) parts.push(hint);
  }
  return parts.join("; ");
}

/** "What's new / What broke / Migration notes" as a markdown section. */
export function renderChangelogMarkdown(diff: VersionDiff, title: string): string {
  const lines: string[] = [];
  lines.push(`## ${title} v${versionLabel(diff.fromVersion)} → v${versionLabel(diff.toVersion)}`, "");

  const breaking = breakingChangesOf(diff);
  if (breaking.length > 0) {
    lines.push(`### What broke (${breaking.length})`, "");
    for (const c of breaking) {
      lines.push(`- \`${c.name}\` — ${label(c)}`, ...sigLines(c));
    }
    lines.push("");
  } else {
    lines.push("No breaking changes.", "");
  }

  if (diff.added.length > 0) {
    lines.push(`### What's new (${diff.added.length})`, "");
    for (const c of diff.added) {
      lines.push(
        `- \`${c.name}\`${c.to?.signature ? ` — \`${c.to.signature}\`` : ""}`,
      );
    }
    lines.push("");
  }

  const soft = diff.changed.filter((c) => !c.breaking);
  if (soft.length > 0) {
    lines.push(`### Changed (${soft.length})`, "");
    for (const c of soft) lines.push(`- \`${c.name}\` — ${label(c)}`);
    lines.push("");
  }

  lines.push("### Migration notes", "");
  if (breaking.length === 0) {
    lines.push("Nothing to do — this release is drop-in compatible.");
  } else {
    for (const c of breaking) {
      lines.push(`- \`${c.name}\` ${migrationHint(c)}`);
    }
  }
  return lines.join("\n").trimEnd() + "\n";
}

/**
 * Insert a changelog section into an existing markdown file: after the
 * leading H1 when present, prepended otherwise. Newest section ends up on top.
 */
export function insertChangelogSection(
  existing: string,
  section: string,
): string {
  const nl = existing.includes("\r\n") ? "\r\n" : "\n";
  const body = section.trimEnd();
  const lines = existing.split(/\r?\n/);
  if (lines.length > 0 && /^#\s/.test(lines[0])) {
    let idx = 1;
    while (idx < lines.length && lines[idx].trim() === "") idx++;
    const tail = lines.slice(idx).join(nl);
    return tail.length === 0
      ? `${lines[0]}${nl}${nl}${body}`
      : `${lines[0]}${nl}${nl}${body}${nl}${nl}${tail}`;
  }
  return existing.length === 0 ? body : `${body}${nl}${nl}${existing}`;
}

export interface CiReportInput {
  title: string;
  /** Doctor report of the head (working tree / PR branch). */
  head: DoctorReport;
  /** Doctor report of the base ref; null when base extraction failed. */
  base: DoctorReport | null;
  /** API diff base -> head; null when the base could not be extracted. */
  diff: VersionDiff | null;
  /** Previously recorded coverage history (may be empty). */
  history: CoverageRecord[];
  baseVersion?: string;
  headVersion?: string;
  /** Surface a warning in the comment when coverage is below this. */
  minCoverage?: number;
}

/** The PR comment: coverage delta + trend sparkline + API diff summary. */
export function renderCiMarkdown(input: CiReportInput): string {
  const { head, base, diff, history } = input;
  const headLabel = input.headVersion ?? "head";
  const baseLabel = input.baseVersion ?? "base";
  const lines: string[] = [CI_COMMENT_MARKER, "", "## BrewDocs report", ""];

  if (base) {
    const delta = head.score - base.score;
    const deltaStr =
      delta === 0 ? "±0" : `${delta > 0 ? "+" : "−"}${Math.abs(delta)}`;
    const icon = delta > 0 ? "▲" : delta < 0 ? "▼" : "►";
    lines.push(
      `**Docs coverage:** ${base.score}% → **${head.score}%** (${icon} ${deltaStr})`,
    );
  } else {
    lines.push(`**Docs coverage:** ${head.score}%`);
  }

  if (input.minCoverage !== undefined && head.score < input.minCoverage) {
    lines.push("", `> ⚠ Coverage is below the configured minimum of ${input.minCoverage}%.`);
  }

  if (history.length >= 2) {
    const scores = history.map((r) => r.score);
    lines.push(
      "",
      `Trend: \`${sparklineUnicode(scores)}\` (${scores[0]}% → ${scores[scores.length - 1]}% over ${scores.length} builds)`,
    );
  }

  if (diff) {
    lines.push("", `**API changes vs \`${baseLabel}\`:** ${diff.summary}`);
    const breaking = breakingChangesOf(diff);
    if (breaking.length > 0) {
      lines.push("", "### Breaking changes", "");
      for (const c of breaking) {
        lines.push(`- \`${c.name}\` — ${label(c)}`, ...sigLines(c));
      }
    }

    lines.push(
      "",
      "<details>",
      `<summary>Full API diff vs <code>${baseLabel}</code></summary>`,
      "",
    );
    if (diff.added.length > 0) {
      lines.push(
        `**Added (${diff.added.length}):** ${diff.added.map((c) => `\`${c.name}\``).join(", ")}`,
        "",
      );
    }
    if (diff.removed.length > 0) {
      lines.push(
        `**Removed (${diff.removed.length}):** ${diff.removed.map((c) => `\`${c.name}\``).join(", ")}`,
        "",
      );
    }
    if (diff.changed.length > 0) {
      lines.push(`**Changed (${diff.changed.length}):**`, "");
      for (const c of diff.changed) {
        lines.push(`- \`${c.name}\` — ${label(c)}`);
      }
      lines.push("");
    }
    if (diff.added.length + diff.removed.length + diff.changed.length === 0) {
      lines.push("No API changes.", "");
    }
    lines.push("</details>");
  } else {
    lines.push(
      "",
      `API diff unavailable — symbols could not be extracted from \`${baseLabel}\`.`,
    );
  }

  const headRows = (r: DoctorReport | null): string[] =>
    r
      ? [
          `${r.documentedSymbols}/${r.totalSymbols}`,
          `${r.paramsDocumented}/${r.paramsTotal}`,
          `${r.returnsDocumented}/${r.returnsTotal}`,
          String(r.examplesTotal),
        ]
      : ["—", "—", "—", "—"];
  const h = headRows(head);
  const b = headRows(base);
  lines.push(
    "",
    "<details>",
    "<summary>Coverage details</summary>",
    "",
    `| metric | ${base ? baseLabel : "—"} | ${headLabel} |`,
    "| --- | --- | --- |",
    `| documented symbols | ${b[0]} | ${h[0]} |`,
    `| documented params | ${b[1]} | ${h[1]} |`,
    `| documented returns | ${b[2]} | ${h[2]} |`,
    `| examples | ${b[3]} | ${h[3]} |`,
    "",
    "</details>",
    "",
    "<sub>Generated by BrewDocs · <code>brewdocs ci</code></sub>",
  );
  return lines.join("\n") + "\n";
}

export interface GateInput {
  breakingCount: number;
  /** A migration guide was generated during this run. */
  guideGenerated: boolean;
  /** A human acknowledged the breaking changes (flag or ack file). */
  acknowledged: boolean;
}

export interface GateDecision {
  ok: boolean;
  reason: string;
}

/**
 * Release gate: breaking changes block the release unless a migration guide
 * was generated or the break is explicitly acknowledged.
 */
export function gateDecision(input: GateInput): GateDecision {
  if (input.breakingCount === 0) {
    return { ok: true, reason: "no breaking changes" };
  }
  if (input.guideGenerated) {
    return {
      ok: true,
      reason: `${input.breakingCount} breaking change(s) covered by a generated migration guide`,
    };
  }
  if (input.acknowledged) {
    return {
      ok: true,
      reason: `${input.breakingCount} breaking change(s) acknowledged`,
    };
  }
  return {
    ok: false,
    reason: `${input.breakingCount} breaking change(s) with no migration guide — generate one with --out <dir>, or pass --acknowledge`,
  };
}

function ackPath(root: string, from: string, to: string): string {
  const safe = (s: string) => s.replace(/[^a-zA-Z0-9._-]/g, "_");
  return path.join(root, ".brewdocs", `migration-${safe(from)}-${safe(to)}.ack.json`);
}

/** Whether the from→to release pair has a recorded acknowledgment. */
export function readAcknowledgment(
  root: string,
  from: string,
  to: string,
): boolean {
  return fs.existsSync(ackPath(root, from, to));
}

/** Record an acknowledgment for the from→to release pair; returns the file. */
export function writeAcknowledgment(
  root: string,
  from: string,
  to: string,
  note?: string,
): string {
  const file = ackPath(root, from, to);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(
    file,
    JSON.stringify(
      { from, to, acknowledgedAt: new Date().toISOString(), note: note ?? "" },
      null,
      2,
    ) + "\n",
    "utf8",
  );
  return file;
}

export interface GitHubCommentTarget {
  token: string;
  /** "owner/name". */
  repo: string;
  pr: number;
  markdown: string;
  marker?: string;
  /** Override for tests. */
  apiBase?: string;
}

/**
 * Post (or update, when a comment with the marker already exists) a PR
 * comment via the GitHub REST API. Dependency-free: uses global fetch.
 */
export async function postGitHubComment(
  target: GitHubCommentTarget,
): Promise<{ created: boolean; url: string }> {
  const api = target.apiBase ?? "https://api.github.com";
  const headers: Record<string, string> = {
    Authorization: `Bearer ${target.token}`,
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    "User-Agent": "brewdocs-ci",
    "Content-Type": "application/json",
  };
  const commentsUrl = `${api}/repos/${target.repo}/issues/${target.pr}/comments?per_page=100`;
  const listRes = await fetch(commentsUrl, { headers });
  if (!listRes.ok) {
    throw new Error(`GitHub API ${listRes.status}: ${await listRes.text()}`);
  }
  const comments = (await listRes.json()) as Array<{ id: number; body?: string }>;
  const marker = target.marker ?? CI_COMMENT_MARKER;
  const existing = comments.find(
    (c) => typeof c.body === "string" && c.body.includes(marker),
  );
  const body = JSON.stringify({ body: target.markdown });
  const res = existing
    ? await fetch(`${api}/repos/${target.repo}/issues/comments/${existing.id}`, {
        method: "PATCH",
        headers,
        body,
      })
    : await fetch(`${api}/repos/${target.repo}/issues/${target.pr}/comments`, {
        method: "POST",
        headers,
        body,
      });
  if (!res.ok) {
    throw new Error(`GitHub API ${res.status}: ${await res.text()}`);
  }
  const data = (await res.json()) as { html_url?: string };
  return { created: !existing, url: data.html_url ?? "" };
}
