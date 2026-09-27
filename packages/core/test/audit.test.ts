import { describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  auditSite,
  build,
  renderAuditText,
  type AuditReport,
} from "@brewdocs/core";

function tmp(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function siteWith(files: Record<string, string>): string {
  const dir = tmp("brewdocs-audit-");
  for (const [name, content] of Object.entries(files)) {
    const target = path.join(dir, name);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, content, "utf8");
  }
  return dir;
}

describe("v3.0 audit suite", () => {
  it("brewed pages pass every check out of the box", () => {
    const out = tmp("brewdocs-audit-build-");
    build({ root: path.resolve(process.cwd(), "examples/lib") }, out);
    const report = auditSite(out);
    const failures = report.checks.filter((c) => !c.pass);
    expect(failures.map((f) => `${f.group}/${f.id}: ${f.files.join(",")}`)).toEqual([]);
    expect(report.score).toBe(100);
    expect(report.groups.a11y).toBe(100);
    expect(report.groups.seo).toBe(100);
    expect(report.groups.perf).toBe(100);
    expect(renderAuditText(report)).toContain("all checks passed");
  });

  it("catches a11y misses: missing lang, unlabelled imgs, skipped headings", () => {
    const dir = siteWith({
      "index.html":
        "<!doctype html><html><head><title>t</title></head><body><h1>a</h1><h4>b</h4><img src=x></body></html>",
    });
    const report = auditSite(dir);
    const ids = report.checks.filter((c) => !c.pass).map((c) => c.id);
    expect(ids).toContain("html-lang");
    expect(ids).toContain("img-alt");
    expect(ids).toContain("heading-order");
  });

  it("catches SEO misses: no meta description, no viewport", () => {
    const dir = siteWith({
      "index.html": "<!doctype html><html lang=\"en\"><head><title>only title</title></head><body><h1>x</h1></body></html>",
    });
    const ids = failingIds(dir);
    expect(ids).toContain("meta-description");
    expect(ids).toContain("viewport");
    expect(ids).toContain("generator");
  });

  it("catches perf misses: remote blocking scripts + BOM", () => {
    const bom = String.fromCharCode(0xfeff);
    const dir = siteWith({
      "index.html":
        bom +
        "<!doctype html><html lang=\"en\"><head><title>t</title><script src=\"https://cdn.example/x.js\"></script></head><body><h1>x</h1></body></html>",
    });
    const ids = failingIds(dir);
    expect(ids).toContain("self-contained");
    expect(ids).toContain("no-bom");
  });

  it("audits nested output (multi-page sites)", () => {
    const out = tmp("brewdocs-audit-multi-");
    build({ root: path.resolve(process.cwd(), "examples/lib") }, path.join(out, "symbols"), {});
    const report = auditSite(out);
    expect(report.pages).toBeGreaterThanOrEqual(1);
    expect(report.checks.length).toBeGreaterThan(0);
  });

  it("throws a helpful error on empty dirs", () => {
    expect(() => auditSite(tmp("brewdocs-audit-empty-"))).toThrow(/no HTML files/);
  });
});

function failingIds(dir: string): string[] {
  const report: AuditReport = auditSite(dir);
  return report.checks.filter((c) => !c.pass).map((c) => c.id);
}
