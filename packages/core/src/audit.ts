import * as fs from "node:fs";
import * as path from "node:path";

/**
 * v3.0 audit suite: a static, dependency-free lighthouse for brewed sites.
 * `build`/`export` output is one self-contained HTML file per page, so the
 * auditor can check a11y, SEO and perf purely by reading the emitted files —
 * no browser, no network. Run it in CI (`brewdocs audit dist --min-score 90`)
 * to stop regressions from shipping.
 */

export type AuditGroup = "a11y" | "seo" | "perf";

export interface AuditCheck {
  /** Stable id, e.g. "img-alt". */
  id: string;
  group: AuditGroup;
  title: string;
  /** How to fix it, shown for failures. */
  hint: string;
  pass: boolean;
  /** Pages that failed (empty when pass). */
  files: string[];
}

export interface AuditReport {
  /** 0-100, equal-weight check average. */
  score: number;
  groups: Record<AuditGroup, number>;
  checks: AuditCheck[];
  pages: number;
  root: string;
}

interface Page {
  file: string; // site-root-relative
  html: string;
}

function collectHtml(dir: string, root = dir): Page[] {
  const out: Page[] = [];
  if (!fs.existsSync(dir)) return out;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (entry.name === "node_modules" || entry.name.startsWith(".")) continue;
      out.push(...collectHtml(path.join(dir, entry.name), root));
      continue;
    }
    if (!entry.name.endsWith(".html")) continue;
    const abs = path.join(dir, entry.name);
    out.push({
      file: path.relative(root, abs).replace(/\\/g, "/"),
      html: fs.readFileSync(abs, "utf8"),
    });
  }
  return out;
}

/** `<tag …>` openers matching `re` inside a document (crude but honest). */
function tagMatches(html: string, re: RegExp): number {
  let n = 0;
  for (const _m of html.matchAll(re)) n++;
  return n;
}

/** Heading sequence of a page, to spot skipped levels (h2 → h4). */
function headingLevels(html: string): number[] {
  const levels: number[] = [];
  for (const m of html.matchAll(/<h([1-6])[ >]/g)) levels.push(Number(m[1]));
  return levels;
}

function check(
  id: string,
  group: AuditGroup,
  title: string,
  hint: string,
  pages: Page[],
  fail: (p: Page) => boolean,
): AuditCheck {
  const files = pages.filter(fail).map((p) => p.file);
  return { id, group, title, hint, pass: files.length === 0, files };
}

export function auditSite(dir: string): AuditReport {
  const root = path.resolve(dir);
  const pages = collectHtml(root);
  if (pages.length === 0) {
    throw new Error(
      `no HTML files found in ${root} — run \`brewdocs build <src> --out ${dir}\` first`,
    );
  }

  const checks: AuditCheck[] = [
    // ---- accessibility -----------------------------------------------
    check("html-lang", "a11y", "every page sets <html lang>", "add locale: <code> to brewdocs.yml", pages,
      (p) => !/<html[^>]*\slang=/.test(p.html)),
    check("img-alt", "a11y", "images carry alt text", "add alt=\"\" for decorative images", pages,
      (p) => /<img\b(?![^>]*\balt=)[^>]*>/i.test(p.html)),
    check("button-name", "a11y", "buttons have an accessible name", "add text or aria-label", pages,
      (p) =>
        tagMatches(p.html, /<button\b(?![^>]*aria-label[^>]*>[^<]*\S)/gi) >
        0 &&
        /<button\b(?![^>]*aria-label)[^>]*>\s*<\/button>/i.test(p.html)),
    check("input-label", "a11y", "inputs are labelled", "add aria-label or a <label for>", pages,
      (p) =>
        /<input\b(?![^>]*type="(hidden|submit|button)")(?![^>]*aria-label)(?![^>]*id=)[^>]*>/i.test(
          p.html,
        )),
    check("heading-order", "a11y", "headings start at h1 and never skip levels", "step h1 → h2 → h3", pages,
      (p) => {
        const levels = headingLevels(p.html);
        if (levels.length === 0) return true;
        if (levels[0] !== 1) return true;
        for (let i = 1; i < levels.length; i++) {
          if (levels[i] > levels[i - 1] + 1) return true;
        }
        return false;
      }),
    check("single-h1", "a11y", "exactly one h1 per page", "demote extra h1s", pages,
      (p) => tagMatches(p.html, /<h1[\s>]/g) !== 1),
    check("reduced-motion", "a11y", "smooth scroll respects prefers-reduced-motion", "wrap scroll-behavior in a media guard", pages,
      (p) =>
        /scroll-behavior:\s*smooth/.test(p.html) &&
        !/prefers-reduced-motion/.test(p.html)),
    check("skip-link", "a11y", "keyboard users get a skip link", "add .skip-link to the shell", pages,
      (p) => /<main\b/.test(p.html) && !/skip-link/.test(p.html)),

    // ---- SEO -----------------------------------------------------------
    check("title", "seo", "non-empty <title>", "pass --name / set a title", pages,
      (p) => !/<title>[^<\s][^<]*<\/title>/.test(p.html)),
    check("meta-description", "seo", "meta description present", "give the package a description", pages,
      (p) => !/<meta\s+name="description"\s+content="[^"]+"/i.test(p.html)),
    check("viewport", "seo", "mobile viewport", "the shell includes it; themes shouldn't drop it", pages,
      (p) => !/<meta\s+name="viewport"/i.test(p.html)),
    check("og-tags", "seo", "Open Graph title/description", "brewed pages emit them when a description exists", pages,
      (p) =>
        /<meta\s+name="description"/i.test(p.html) &&
        !/<meta\s+property="og:title"/i.test(p.html)),
    check("generator", "seo", "generator meta tag", "brewed output includes it", pages,
      (p) => !/<meta\s+name="generator"/i.test(p.html)),

    // ---- performance ----------------------------------------------------
    check("charset", "perf", "<meta charset> in the first bytes", "the shell includes it", pages,
      (p) => !/<meta\s+charset=/i.test(p.html.slice(0, 400))),
    check("self-contained", "perf", "no render-blocking remote <script>/<link>", "BrewDocs output should be self-contained", pages,
      (p) =>
        /<script\b[^>]*\bsrc=["']https?:/i.test(p.html) ||
        /<link\b[^>]*rel=["']stylesheet["'][^>]*href=["']https?:/i.test(p.html)),
    check("size-budget", "perf", "page ≤ 1.5 MB", "trim examples or use --multi", pages,
      (p) => Buffer.byteLength(p.html, "utf8") > 1.5 * 1024 * 1024),
    check("no-bom", "perf", "no BOM in UTF-8 output", "write tooling should emit clean UTF-8", pages,
      (p) => p.html.charCodeAt(0) === 0xfeff),
  ];

  const groups: Record<AuditGroup, number> = { a11y: 0, seo: 0, perf: 0 };
  const totals: Record<AuditGroup, number> = { a11y: 0, seo: 0, perf: 0 };
  for (const c of checks) {
    totals[c.group]++;
    if (c.pass) groups[c.group]++;
  }
  const pct = (g: AuditGroup) =>
    totals[g] === 0 ? 100 : Math.round((groups[g] / totals[g]) * 100);
  const passed = checks.filter((c) => c.pass).length;

  return {
    score: Math.round((passed / checks.length) * 100),
    groups: { a11y: pct("a11y"), seo: pct("seo"), perf: pct("perf") },
    checks,
    pages: pages.length,
    root,
  };
}

/** One-line-per-check text report (same shape as doctor's output). */
export function renderAuditText(report: AuditReport): string {
  const lines: string[] = [];
  lines.push(
    `🔎 audit — score ${report.score}%  ·  a11y ${report.groups.a11y}%  ·  seo ${report.groups.seo}%  ·  perf ${report.groups.perf}%  ·  ${report.pages} page(s)`,
  );
  const failing = report.checks.filter((c) => !c.pass);
  if (failing.length === 0) {
    lines.push("   all checks passed. Ship it. ☕");
    return lines.join("\n");
  }
  for (const c of failing) {
    const where =
      c.files.length <= 3
        ? c.files.join(", ")
        : `${c.files.slice(0, 3).join(", ")} (+${c.files.length - 3} more)`;
    lines.push(`   ✗ [${c.group}] ${c.title} — ${where}`);
    lines.push(`     · ${c.hint}`);
  }
  return lines.join("\n");
}
