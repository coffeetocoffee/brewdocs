import { afterEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as http from "node:http";
import * as os from "node:os";
import * as path from "node:path";
import type { AddressInfo } from "node:net";
import {
  CI_COMMENT_MARKER,
  breakingChangesOf,
  gateDecision,
  insertChangelogSection,
  loadCoverageHistory,
  postGitHubComment,
  readAcknowledgment,
  recordCoverage,
  renderChangelogMarkdown,
  renderCiMarkdown,
  sparklineSvg,
  sparklineUnicode,
  writeAcknowledgment,
  type CoverageRecord,
} from "./ci.js";
import { diffSymbols, describeChange } from "./diff.js";
import type { DoctorReport } from "./doctor.js";
import type { SymbolDoc } from "./types.js";

let tmpDirs: string[] = [];

function tmpDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "brewdocs-ci-"));
  tmpDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tmpDirs) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  tmpDirs = [];
});

function report(score: number): DoctorReport {
  return {
    score,
    totalSymbols: 5,
    documentedSymbols: 4,
    paramsTotal: 4,
    paramsDocumented: 3,
    returnsTotal: 2,
    returnsDocumented: 2,
    examplesTotal: 3,
    issues: [],
  };
}

function sym(partial: Partial<SymbolDoc> & { name: string }): SymbolDoc {
  return { kind: "function", params: [], examples: [], ...partial };
}

describe("CI guardian — coverage history", () => {
  it("records and loads coverage history", () => {
    const root = tmpDir();
    recordCoverage(root, report(70), "1.0.0");
    recordCoverage(root, report(80), "1.1.0");
    const history = loadCoverageHistory(root);
    expect(history.map((r) => r.score)).toEqual([70, 80]);
    expect(history[1].version).toBe("1.1.0");
    expect(fs.existsSync(path.join(root, ".brewdocs", "coverage.json"))).toBe(true);
  });

  it("re-records the same version in place and caps at 100 entries", () => {
    const root = tmpDir();
    recordCoverage(root, report(70), "1.1.0");
    recordCoverage(root, report(90), "1.1.0");
    let history = loadCoverageHistory(root);
    expect(history).toHaveLength(1);
    expect(history[0].score).toBe(90);
    for (let i = 0; i < 120; i++) {
      recordCoverage(root, report(i), `dev-${i}`);
    }
    history = loadCoverageHistory(root);
    expect(history).toHaveLength(100);
    expect(history[0].version).toBe("dev-20");
  });

  it("returns [] when no history exists", () => {
    expect(loadCoverageHistory(tmpDir())).toEqual([]);
  });
});

describe("CI guardian — sparklines", () => {
  it("maps scores onto absolute 0-100 blocks", () => {
    expect(sparklineUnicode([0, 50, 100])).toBe("▁▅█");
    expect(sparklineUnicode([100])).toBe("█");
    expect(sparklineUnicode([])).toBe("");
  });

  it("renders an SVG polyline", () => {
    const svg = sparklineSvg([10, 50, 90]);
    expect(svg.startsWith("<svg")).toBe(true);
    expect(svg).toContain("<polyline");
    expect(svg.match(/[\d.]+,[\d.]+/g)).toHaveLength(3);
  });
});

describe("CI guardian — changelog", () => {
  it("renders what broke / what's new / migration notes", () => {
    const diff = diffSymbols(
      "1.0.0",
      [
        sym({ name: "gone", signature: "gone(): void" }),
        sym({ name: "f", signature: "f(a: string): void" }),
        sym({ name: "old", signature: "old(): void" }),
      ],
      "2.0.0",
      [
        sym({ name: "fresh", signature: "fresh(): void", description: "d" }),
        sym({ name: "f", signature: "f(a: string, b: number): void" }),
        sym({ name: "old", signature: "old(): void", deprecated: "use fresh" }),
      ],
    );
    const md = renderChangelogMarkdown(diff, "mylib");
    expect(md).toContain("## mylib v1.0.0 → v2.0.0");
    expect(md).toContain("### What broke (2)");
    expect(md).toContain("`gone` — removed");
    expect(md).toContain("- old: `f(a: string): void`");
    expect(md).toContain("- new: `f(a: string, b: number): void`");
    expect(md).toContain("### What's new (1)");
    expect(md).toContain("`fresh` — `fresh(): void`");
    expect(md).toContain("`old` — deprecated");
    expect(md).toContain("### Migration notes");
    expect(md).toContain("`gone` was removed");
    expect(md).toContain("`f` changed signature");
  });

  it("says nothing to migrate for a compatible release", () => {
    const symbols = [sym({ name: "f", signature: "f(): void", description: "d" })];
    const md = renderChangelogMarkdown(
      diffSymbols("1.0.0", symbols, "1.0.1", symbols),
      "lib",
    );
    expect(md).toContain("No breaking changes.");
    expect(md).toContain("drop-in compatible");
  });

  it("says 'use X instead' when the removed symbol named its successor", () => {
    const diff = diffSymbols(
      "1.0.0",
      [
        sym({
          name: "gone",
          deprecated: "use better instead",
          see: ["better"],
          replacements: ["better"],
        }),
      ],
      "2.0.0",
      [sym({ name: "better", description: "d" })],
    );
    const md = renderChangelogMarkdown(diff, "mylib");
    expect(md).toContain("`gone` was removed — use `better` instead");
  });

  it("says 'use X instead' for a newly deprecated symbol on the diff page", () => {
    const diff = diffSymbols(
      "1.0.0",
      [sym({ name: "f", signature: "f(): void" })],
      "2.0.0",
      [sym({ name: "f", signature: "f(): void", deprecated: true, replacements: ["g"] })],
    );
    const changed = diff.changed.find((c) => c.name === "f")!;
    expect(changed.changes).toContain("deprecated");
    expect(describeChange("deprecated", changed)).toBe("deprecated — use `g` instead");
  });

  it("exposes breaking changes as removed + breaking-changed", () => {
    const diff = diffSymbols(
      "1.0.0",
      [sym({ name: "gone" }), sym({ name: "kept", signature: "kept(): void" })],
      "2.0.0",
      [sym({ name: "kept", signature: "kept(x: number): void" })],
    );
    expect(breakingChangesOf(diff).map((c) => c.name)).toEqual(["gone", "kept"]);
  });

  it("inserts sections after the H1 and is append-safe", () => {
    const section = "## lib v1.0.0 → v2.0.0\n\n### What broke (1)";
    expect(insertChangelogSection("", section)).toBe(section);
    const withH1 = "# Changelog\n\n## v0.9.0\n\nold stuff\n";
    const out = insertChangelogSection(withH1, section);
    expect(out.startsWith("# Changelog\n\n## lib v1.0.0 → v2.0.0")).toBe(true);
    expect(out).toContain("## v0.9.0");
    const noH1 = "## v0.9.0\n\nold\n";
    expect(insertChangelogSection(noH1, section).startsWith(section)).toBe(true);
  });
});

describe("CI guardian — PR comment", () => {
  const history: CoverageRecord[] = [
    { version: "1.0.0", score: 70, timestamp: "t1", totalSymbols: 5, documentedSymbols: 3 },
    { version: "1.1.0", score: 90, timestamp: "t2", totalSymbols: 5, documentedSymbols: 4 },
  ];

  it("renders coverage delta, trend and API diff", () => {
    const base = report(82);
    const head = report(76);
    const diff = diffSymbols(
      "1.0.0",
      [sym({ name: "gone", signature: "gone(): void" })],
      "2.0.0",
      [sym({ name: "fresh", signature: "fresh(): void", description: "d" })],
    );
    const md = renderCiMarkdown({
      title: "lib",
      head,
      base,
      diff,
      history: [
        ...history,
        {
          version: "2.0.0",
          score: head.score,
          timestamp: "t3",
          totalSymbols: 5,
          documentedSymbols: 4,
        },
      ],
      baseVersion: "origin/main",
      headVersion: "2.0.0",
      minCoverage: 80,
    });
    expect(md).toContain(CI_COMMENT_MARKER);
    expect(md).toContain("**Docs coverage:** 82% → **76%** (▼ −6)");
    expect(md).toContain("below the configured minimum of 80%");
    expect(md).toContain("`▆█▇`");
    expect(md).toContain("70% → 76% over 3 builds");
    expect(md).toContain("### Breaking changes");
    expect(md).toContain("`gone` — removed");
    expect(md).toContain("| metric | origin/main | 2.0.0 |");
  });

  it("degrades when base extraction failed", () => {
    const md = renderCiMarkdown({
      title: "lib",
      head: report(50),
      base: null,
      diff: null,
      history: [],
    });
    expect(md).toContain("**Docs coverage:** 50%");
    expect(md).toContain("API diff unavailable");
    expect(md).toContain("| metric | — | head |");
  });
});

describe("CI guardian — release gate", () => {
  it("passes with no breaking changes", () => {
    const d = gateDecision({ breakingCount: 0, guideGenerated: false, acknowledged: false });
    expect(d.ok).toBe(true);
    expect(d.reason).toContain("no breaking changes");
  });

  it("passes when a guide was generated or acknowledged", () => {
    expect(gateDecision({ breakingCount: 3, guideGenerated: true, acknowledged: false }).ok).toBe(true);
    expect(gateDecision({ breakingCount: 3, guideGenerated: false, acknowledged: true }).ok).toBe(true);
  });

  it("blocks unhandled breaking changes", () => {
    const d = gateDecision({ breakingCount: 2, guideGenerated: false, acknowledged: false });
    expect(d.ok).toBe(false);
    expect(d.reason).toContain("2 breaking change(s)");
    expect(d.reason).toContain("--out <dir>");
  });

  it("records and reads acknowledgments per version pair", () => {
    const root = tmpDir();
    expect(readAcknowledgment(root, "v1.0.0", "v2.0.0")).toBe(false);
    const file = writeAcknowledgment(root, "v1.0.0", "v2.0.0", "reviewed");
    expect(fs.existsSync(file)).toBe(true);
    expect(readAcknowledgment(root, "v1.0.0", "v2.0.0")).toBe(true);
    expect(readAcknowledgment(root, "v1.0.0", "v3.0.0")).toBe(false);
    const record = JSON.parse(fs.readFileSync(file, "utf8")) as { note?: string };
    expect(record.note).toBe("reviewed");
  });
});

describe("CI guardian — GitHub comment", () => {
  it("creates, then updates the marker-tracked comment", async () => {
    const calls: Array<{ method: string; url: string; body: string }> = [];
    let existing: Array<{ id: number; body: string }> = [];
    const server = http.createServer((req, res) => {
      let body = "";
      req.on("data", (chunk) => (body += chunk));
      req.on("end", () => {
        calls.push({ method: req.method ?? "", url: req.url ?? "", body });
        res.setHeader("Content-Type", "application/json");
        if (req.method === "GET") {
          res.end(JSON.stringify(existing));
        } else {
          res.end(JSON.stringify({ html_url: "https://example.test/comment/1" }));
        }
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      const { port } = server.address() as AddressInfo;
      const target = {
        token: "t",
        repo: "o/r",
        pr: 7,
        markdown: `${CI_COMMENT_MARKER}\nreport`,
        apiBase: `http://127.0.0.1:${port}`,
      };
      const created = await postGitHubComment(target);
      expect(created.created).toBe(true);
      expect(calls[0].method).toBe("GET");
      expect(calls[1].method).toBe("POST");
      expect(calls[1].url).toContain("/repos/o/r/issues/7/comments");

      existing = [{ id: 42, body: `old ${CI_COMMENT_MARKER} comment` }];
      calls.length = 0;
      const updated = await postGitHubComment(target);
      expect(updated.created).toBe(false);
      expect(calls[0].method).toBe("GET");
      expect(calls[1].method).toBe("PATCH");
      expect(calls[1].url).toContain("/issues/comments/42");
      expect(JSON.parse(calls[1].body)).toHaveProperty("body");
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
