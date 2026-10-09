import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as http from "node:http";
import * as os from "node:os";
import * as path from "node:path";
import { run } from "./index.js";
import { listenLocal } from "./test-util.js";

describe("v4.5 CLI — the loop", () => {
  let cwd: string;
  let tmp: string;

  beforeEach(() => {
    cwd = process.cwd();
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "brewdocs-v45-cli-"));
    process.chdir(tmp);
  });

  afterEach(() => {
    process.chdir(cwd);
    process.exitCode = 0;
  });

  /** Capture console.log while `fn` runs. */
  async function capture(fn: () => Promise<void>): Promise<string> {
    const logs: string[] = [];
    const orig = console.log;
    console.log = (...args: unknown[]) => logs.push(args.join(" "));
    try {
      await fn();
    } finally {
      console.log = orig;
    }
    return logs.join("\n");
  }

  /**
   * Write an analytics store as the server would persist it. The query key is
   * `tool\u0000query`; entries with misses > 0 are the documentation gap.
   */
  function seedAnalytics(hosting: string): void {
    const row = (tool: string, query: string, calls: number, misses: number) => ({
      tool,
      query,
      calls,
      misses,
      lastHits: misses === calls ? 0 : 1,
      lastAt: "2026-10-03T00:00:00.000Z",
    });
    const store = {
      cafe: {
        views: 4,
        builds: 1,
        queries: {
          ["search_symbols\u0000espresso"]: row("search_symbols", "espresso", 3, 3),
          ["symbol_signature\u0000latteArt"]: row("symbol_signature", "latteArt", 1, 1),
          ["search_symbols\u0000brew"]: row("search_symbols", "brew", 5, 0),
        },
      },
    };
    fs.mkdirSync(hosting, { recursive: true });
    fs.writeFileSync(path.join(hosting, ".analytics.json"), JSON.stringify(store), "utf8");
  }

  it("gap prints unanswered queries, ranked, and omits answered ones", async () => {
    const hosting = path.join(tmp, "hosting");
    seedAnalytics(hosting);
    const out = await capture(() => run(["gap", "--hosting", hosting]));
    expect(out).toContain("espresso");
    expect(out).toContain("latteArt");
    // "brew" was found every time — it is not a gap.
    expect(out).not.toContain('"brew"');
    // Ranked by misses: espresso (3) before latteArt (1).
    expect(out.indexOf("espresso")).toBeLessThan(out.indexOf("latteArt"));
  });

  it("gap --json emits the structured report and honours --site / --limit", async () => {
    const hosting = path.join(tmp, "hosting");
    seedAnalytics(hosting);
    const out = await capture(() =>
      run(["gap", "--hosting", hosting, "--site", "cafe", "--limit", "1", "--json"]),
    );
    const parsed = JSON.parse(out) as { site: string; gaps: Array<{ query: string; misses: number }> };
    expect(parsed.site).toBe("cafe");
    expect(parsed.gaps).toHaveLength(1);
    expect(parsed.gaps[0]).toMatchObject({ query: "espresso", misses: 3 });
  });

  it("gap reports an empty store plainly instead of an empty list", async () => {
    const hosting = path.join(tmp, "hosting");
    fs.mkdirSync(hosting, { recursive: true });
    const out = await capture(() => run(["gap", "--hosting", hosting]));
    expect(out).toContain("No unanswered queries recorded");
  });

  it("federate add fetches a deployed site's docmodel.json over HTTP", async () => {
    // Build a real docmodel to serve as if it were a deployed site.
    const src = path.join(tmp, "remote-lib");
    fs.mkdirSync(src, { recursive: true });
    fs.writeFileSync(
      path.join(src, "package.json"),
      JSON.stringify({ name: "remote-lib", version: "1.0.0", main: "index.js" }),
      "utf8",
    );
    fs.writeFileSync(
      path.join(src, "index.js"),
      `/** Brew a cup. */\nexport function brew(kind) { return kind; }\n`,
      "utf8",
    );
    const dist = path.join(tmp, "dist");
    await run(["build", src, "--out", dist]);
    const body = fs.readFileSync(path.join(dist, "docmodel.json"), "utf8");

    const server = http.createServer((_req, res) => {
      res.writeHead(200, { "content-type": "application/json" }).end(body);
    });
    // v4.7 finding #30: loopback only — a bare listen(0) binds every interface.
    const port = await listenLocal(server);

    const store = path.join(tmp, "fed");
    try {
      await run(["federate", "add", "remote-lib", `http://127.0.0.1:${port}/s/remote-lib/`, "--store", store]);
      const indexed = JSON.parse(
        fs.readFileSync(path.join(store, ".federation.json"), "utf8"),
      ) as { repos: Array<{ name: string; source: string; symbols: Array<{ name: string }> }> };
      expect(indexed.repos).toHaveLength(1);
      expect(indexed.repos[0].name).toBe("remote-lib");
      expect(indexed.repos[0].source).toContain("/s/remote-lib/docmodel.json");
      expect(indexed.repos[0].symbols.map((s) => s.name)).toContain("brew");
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
    }
  });

  it("federate add still indexes a local directory (the URL path is additive)", async () => {
    const src = path.join(tmp, "local-lib");
    fs.mkdirSync(src, { recursive: true });
    fs.writeFileSync(
      path.join(src, "package.json"),
      JSON.stringify({ name: "local-lib", version: "1.0.0", main: "index.js" }),
      "utf8",
    );
    fs.writeFileSync(
      path.join(src, "index.js"),
      `/** Pour it. */\nexport function pour() { return 1; }\n`,
      "utf8",
    );
    const dist = path.join(tmp, "dist2");
    await run(["build", src, "--out", dist]);
    const store = path.join(tmp, "fed2");
    await run(["federate", "add", "local-lib", dist, "--store", store]);
    const indexed = JSON.parse(
      fs.readFileSync(path.join(store, ".federation.json"), "utf8"),
    ) as { repos: Array<{ name: string }> };
    expect(indexed.repos[0].name).toBe("local-lib");
  });
});
