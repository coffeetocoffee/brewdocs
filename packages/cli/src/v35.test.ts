import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { run } from "./index.js";

describe("v3.5 CLI commands", () => {
  let cwd: string;
  let tmp: string;

  beforeEach(() => {
    cwd = process.cwd();
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "brewdocs-v35-cli-"));
    process.chdir(tmp);
  });

  afterEach(() => {
    process.chdir(cwd);
    process.exitCode = 0;
  });

  /** A small JS package we can mutate between drift runs. */
  function sourceDir(name: string, body: string): string {
    const src = path.join(tmp, name);
    fs.mkdirSync(src, { recursive: true });
    fs.writeFileSync(
      path.join(src, "package.json"),
      JSON.stringify({ name, version: "1.0.0", main: "index.js" }),
      "utf8",
    );
    fs.writeFileSync(path.join(src, "index.js"), body, "utf8");
    return src;
  }

  const DOCUMENTED = `/**
 * Brew a cup.
 * @param {string} kind - what to brew
 * @returns {string} the cup
 */
export function brew(kind) { return "cup of " + kind; }
`;

  it("drift --record writes a baseline, then reports stale docs after a code change", async () => {
    const src = sourceDir("lib", DOCUMENTED);
    await run(["drift", src, "--record"]);
    expect(fs.existsSync(path.join(src, ".brewdocs", "drift.json"))).toBe(true);

    // In sync right after recording.
    await run(["drift", src]);
    expect(process.exitCode).not.toBe(1);

    // Code changes, JSDoc doesn't.
    fs.writeFileSync(
      path.join(src, "index.js"),
      DOCUMENTED.replace("brew(kind)", "brew(kind, strength)"),
      "utf8",
    );
    await run(["drift", src, "--fail-on-drift"]);
    expect(process.exitCode).toBe(1);
  });

  it("drift without a baseline fails with a helpful error", async () => {
    const src = sourceDir("fresh", DOCUMENTED);
    await expect(run(["drift", src])).rejects.toThrow(/no drift baseline/);
  });

  it("drift --json emits a machine-readable report", async () => {
    const src = sourceDir("lib", DOCUMENTED);
    await run(["drift", src, "--record"]);
    await run(["drift", src, "--json"]);
    expect(process.exitCode).not.toBe(1);
  });

  it("drift --from compares against a git tag", { timeout: 60_000 }, async () => {
    const src = sourceDir("lib", DOCUMENTED);
    const git = (args: string[]) =>
      execFileSync("git", args, { cwd: src, stdio: "ignore" });
    git(["init"]);
    git(["config", "user.email", "test@example.com"]);
    git(["config", "user.name", "test"]);
    git(["add", "."]);
    git(["commit", "-m", "init"]);
    git(["tag", "v1.0.0"]);

    // Move the code on without touching the docs.
    fs.writeFileSync(
      path.join(src, "index.js"),
      DOCUMENTED.replace("brew(kind)", "brew(kind, strength)"),
      "utf8",
    );
    await run(["drift", src, "--from", "v1.0.0", "--json"]);
    expect(process.exitCode).not.toBe(1);
  });

  it("federate add/list/search/remove round-trips over built docmodels", async () => {
    const src = sourceDir("acme-lib", DOCUMENTED);
    await run(["build", src, "--out", path.join(tmp, "dist-acme")]);
    const other = sourceDir(
      "other-kit",
      `/** Render HTML. */\nexport function render(html) { return html; }\n`,
    );
    await run(["build", other, "--out", path.join(tmp, "dist-other")]);

    const store = path.join(tmp, "fed");
    await run(["federate", "add", "acme-lib", path.join(tmp, "dist-acme"), "--store", store]);
    await run([
      "federate", "add", "other-kit", path.join(tmp, "dist-other"),
      "--url", "https://other.example.com", "--store", store,
    ]);
    expect(fs.existsSync(path.join(store, ".federation.json"))).toBe(true);

    await run(["federate", "list", "--store", store, "--json"]);
    await run(["federate", "search", "brew", "--store", store]);
    await run(["federate", "search", "render", "--store", store, "--json"]);

    await run(["federate", "remove", "acme-lib", "--store", store]);
    const listed = JSON.parse(
      fs.readFileSync(path.join(store, ".federation.json"), "utf8"),
    ) as { repos: Array<{ slug: string }> };
    expect(listed.repos.map((r) => r.slug)).toEqual(["other-kit"]);
  });

  it("federate page writes a standalone search page", async () => {
    const src = sourceDir("acme-lib", DOCUMENTED);
    await run(["build", src, "--out", path.join(tmp, "dist")]);
    const store = path.join(tmp, "fed");
    await run(["federate", "add", "acme-lib", path.join(tmp, "dist"), "--store", store]);
    await run(["federate", "page", "--store", store, "--out", path.join(tmp, "site")]);
    const html = fs.readFileSync(path.join(tmp, "site", "index.html"), "utf8");
    expect(html).toContain("acme-lib");
    expect(html).toContain("brew");
  });

  it("federate add fails cleanly on a missing docmodel", async () => {
    await run(["federate", "add", "ghost", path.join(tmp, "nope"), "--store", path.join(tmp, "fed")]);
    expect(process.exitCode).toBe(1);
  });

  it("federate search keeps flag values out of the query", async () => {
    const src = sourceDir(
      "acme-lib",
      `/** Brew a cup of docs. */\nexport function brewCup(kind) { return kind; }\n`,
    );
    await run(["build", src, "--out", path.join(tmp, "dist")]);
    const store = path.join(tmp, "fed");
    await run(["federate", "add", "acme-lib", path.join(tmp, "dist"), "--store", store]);

    // Multi-word query + flags: neither "--store" nor its path may leak in.
    const logs: string[] = [];
    const orig = console.log;
    console.log = (...args: unknown[]) => logs.push(args.join(" "));
    try {
      await run(["federate", "search", "brew", "cup", "--store", store, "--limit", "5"]);
    } finally {
      console.log = orig;
    }
    const out = logs.join("\n");
    expect(out).toContain("brewCup");
    expect(out).not.toContain("no symbols match");
  });

  it("GET /api/search answers over the federation store beside the hosting dir", async () => {
    const src = sourceDir("acme-lib", DOCUMENTED);
    await run(["build", src, "--out", path.join(tmp, "dist")]);
    const hosting = path.join(tmp, "hosting");
    fs.mkdirSync(hosting, { recursive: true });
    await run(["federate", "add", "acme-lib", path.join(tmp, "dist"), "--store", hosting]);

    const { createServer } = await import("./server.js");
    const server = createServer(hosting);
    await new Promise<void>((r) => server.listen(0, r));
    const addr = server.address();
    const port = typeof addr === "object" && addr ? addr.port : 0;
    try {
      const miss = await fetch(`http://127.0.0.1:${port}/api/search`);
      expect(miss.status).toBe(400);

      const hit = await fetch(`http://127.0.0.1:${port}/api/search?q=brew`);
      expect(hit.status).toBe(200);
      const body = (await hit.json()) as {
        query: string;
        hits: Array<{ name: string; repo: string }>;
      };
      expect(body.query).toBe("brew");
      expect(body.hits.map((h) => h.name)).toContain("brew");
      expect(body.hits[0].repo).toBe("acme-lib");

      const limited = await fetch(`http://127.0.0.1:${port}/api/search?q=brew&limit=1`);
      const limitedBody = (await limited.json()) as { hits: unknown[] };
      expect(limitedBody.hits).toHaveLength(1);
    } finally {
      server.close();
    }
  });
});
