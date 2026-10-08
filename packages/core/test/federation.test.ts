import { afterEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { buildDocModel } from "../src/docmodel.js";
import {
  addFederatedRepo,
  addFederatedRepoFromUrl,
  buildFederatedPage,
  listFederatedRepos,
  loadFederation,
  removeFederatedRepo,
  resolveDocModelPath,
  searchFederation,
} from "../src/federation.js";

let tmpDirs: string[] = [];

function tmpDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "brewdocs-fed-"));
  tmpDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tmpDirs) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  tmpDirs = [];
});

/** A source package + its built docmodel.json, ready to index. */
function builtRepo(
  name: string,
  symbols: Array<{ name: string; desc: string; sig: string }>,
): string {
  const src = tmpDir();
  fs.writeFileSync(
    path.join(src, "package.json"),
    JSON.stringify({ name, version: "1.0.0", main: "index.js" }),
    "utf8",
  );
  const body = symbols
    .map(
      (s) =>
        `/** ${s.desc} */\nexport function ${s.name}(x) { return x; }\n`,
    )
    .join("\n");
  fs.writeFileSync(path.join(src, "index.js"), body, "utf8");
  const out = tmpDir();
  buildDocModel({ root: src }, out);
  return out;
}

describe("v3.5 federation — store", () => {
  it("adds a repo from a docmodel directory and lists it", () => {
    const store = tmpDir();
    const repoDir = builtRepo("acme-lib", [
      { name: "brew", desc: "Brew a cup.", sig: "" },
      { name: "pour", desc: "Pour it.", sig: "" },
    ]);
    const repo = addFederatedRepo(store, "acme-lib", repoDir);
    expect(repo).not.toBeNull();
    expect(repo!.slug).toBe("acme-lib");
    expect(repo!.symbols.map((s) => s.name).sort()).toEqual(["brew", "pour"]);
    expect(fs.existsSync(path.join(store, ".federation.json"))).toBe(true);

    const repos = listFederatedRepos(store);
    expect(repos).toHaveLength(1);
    expect(repos[0].version).toBe("1.0.0");
  });

  it("accepts a direct docmodel.json path and builds deep links from --url", () => {
    const store = tmpDir();
    const repoDir = builtRepo("widgets", [{ name: "render", desc: "Render.", sig: "" }]);
    const file = path.join(repoDir, "docmodel.json");
    expect(resolveDocModelPath(file)).toBe(file);
    const repo = addFederatedRepo(store, "widgets", file, {
      url: "https://widgets.example.com/",
    });
    expect(repo!.url).toBe("https://widgets.example.com/");
    const render = repo!.symbols.find((s) => s.name === "render")!;
    expect(render.url).toBe("https://widgets.example.com/#symbol-render");
  });

  it("re-adding the same repo replaces in place, never duplicates", () => {
    const store = tmpDir();
    const first = builtRepo("dup", [{ name: "a", desc: "A.", sig: "" }]);
    addFederatedRepo(store, "dup", first);
    const second = builtRepo("dup", [
      { name: "a", desc: "A.", sig: "" },
      { name: "b", desc: "B.", sig: "" },
    ]);
    addFederatedRepo(store, "dup", second);
    const repos = listFederatedRepos(store);
    expect(repos).toHaveLength(1);
    expect(repos[0].symbols).toHaveLength(2);
  });

  it("rejects missing or invalid docmodels without crashing", () => {
    const store = tmpDir();
    expect(addFederatedRepo(store, "ghost", path.join(store, "nope"))).toBeNull();
    const bad = tmpDir();
    fs.writeFileSync(path.join(bad, "docmodel.json"), '{"schema":"wrong"}', "utf8");
    expect(addFederatedRepo(store, "bad", bad)).toBeNull();
    expect(listFederatedRepos(store)).toHaveLength(0);
  });

  it("removes a repo by name", () => {
    const store = tmpDir();
    addFederatedRepo(store, "acme-lib", builtRepo("acme-lib", [{ name: "x", desc: "X.", sig: "" }]));
    expect(removeFederatedRepo(store, "acme-lib")).toBe(true);
    expect(removeFederatedRepo(store, "acme-lib")).toBe(false);
    expect(listFederatedRepos(store)).toHaveLength(0);
  });
});

describe("v3.5 federation — ranked search", () => {
  function seededStore(): string {
    const store = tmpDir();
    addFederatedRepo(store, "acme-lib", builtRepo("acme-lib", [
      { name: "brew", desc: "Brew a fresh cup.", sig: "" },
      { name: "pour", desc: "Pour the brew.", sig: "" },
    ]));
    addFederatedRepo(store, "other-kit", builtRepo("other-kit", [
      { name: "render", desc: "Render HTML.", sig: "" },
      { name: "brewTemp", desc: "Temperature helper.", sig: "" },
    ]));
    return store;
  }

  it("searches symbols across every indexed repo", () => {
    const hits = searchFederation(loadFederation(seededStore()), "brew");
    const names = hits.map((h) => `${h.repo}/${h.name}`);
    expect(names).toContain("acme-lib/brew");
    expect(names).toContain("other-kit/brewTemp");
  });

  it("ranks exact-name hits above body hits", () => {
    const hits = searchFederation(loadFederation(seededStore()), "brew");
    expect(hits[0].name).toBe("brew");
  });

  it("matches repo names too", () => {
    const hits = searchFederation(loadFederation(seededStore()), "acme");
    expect(hits.length).toBeGreaterThan(0);
    expect(hits.every((h) => h.repo === "acme-lib")).toBe(true);
  });

  it("returns [] for an empty query and respects the limit", () => {
    const store = loadFederation(seededStore());
    expect(searchFederation(store, "  ")).toEqual([]);
    expect(searchFederation(store, "brew", { limit: 1 })).toHaveLength(1);
  });
});

describe("v3.5 federation — page", () => {
  it("builds a standalone search page embedding the whole index", () => {
    const store = tmpDir();
    addFederatedRepo(store, "acme-lib", builtRepo("acme-lib", [{ name: "brew", desc: "Brew a cup.", sig: "" }]));
    const out = tmpDir();
    const file = buildFederatedPage(store, out);
    expect(file).toBe(path.join(out, "index.html"));
    const html = fs.readFileSync(file, "utf8");
    expect(html).toContain("Federated Search");
    expect(html).toContain("acme-lib");
    expect(html).toContain("brew");
    expect(html).toContain('id="fed-index"');
    expect(html).toContain("</html>");
  });

  it("renders an empty state when nothing is indexed", () => {
    const html = fs.readFileSync(buildFederatedPage(tmpDir(), tmpDir()), "utf8");
    expect(html).toContain("federate add");
  });

  it("neutralizes hostile script and comment sequences in the embedded fed-index script block (INV-4)", () => {
    const store = tmpDir();
    addFederatedRepo(
      store,
      "hostile-lib",
      builtRepo("hostile-lib", [
        {
          name: "pwn",
          desc: '</script><script>alert("xss")</script><!--<script>',
          sig: "export function pwn(): void",
        },
      ]),
    );
    const out = tmpDir();
    const file = buildFederatedPage(store, out);
    const html = fs.readFileSync(file, "utf8");
    const scriptMatch = /<script id="fed-index" type="application\/json">([\s\S]*?)<\/script>/.exec(html);
    expect(scriptMatch).not.toBeNull();
    const jsonContent = scriptMatch![1];
    // Must not contain any unescaped '<' that could break out or confuse tokenizers
    expect(jsonContent).not.toContain("<");
    expect(jsonContent).toContain("\\u003c/script>");
    expect(jsonContent).toContain("\\u003c!--\\u003cscript>");
    // Client-side JSON.parse must recover original data
    const parsed = JSON.parse(jsonContent);
    expect(parsed[0].symbols[0].d).toBe('</script><script>alert("xss")</script><!--<script>');
  });
});

describe("v4.5 federation — index a deployed site over HTTP", () => {
  /** Serve `body` at every path; returns the base URL. */
  async function serve(body: string, status = 200): Promise<{ base: string; close: () => Promise<void> }> {
    const http = await import("node:http");
    const server = http.createServer((_req, res) => {
      res.writeHead(status, { "content-type": "application/json" }).end(body);
    });
    await new Promise<void>((r) => server.listen(0, r));
    const addr = server.address();
    const port = typeof addr === "object" && addr ? addr.port : 0;
    return {
      base: `http://127.0.0.1:${port}`,
      close: () => new Promise<void>((r) => server.close(() => r())),
    };
  }

  it("fetches a site's docmodel.json and indexes it", async () => {
    const repoDir = builtRepo("remote-lib", [
      { name: "brew", desc: "Brew a cup.", sig: "" },
      { name: "pour", desc: "Pour it.", sig: "" },
    ]);
    const body = fs.readFileSync(path.join(repoDir, "docmodel.json"), "utf8");
    const { base, close } = await serve(body);
    try {
      const store = tmpDir();
      const repo = await addFederatedRepoFromUrl(store, "remote-lib", `${base}/s/remote-lib/`);
      expect(repo).not.toBeNull();
      expect(repo!.symbols.map((s) => s.name).sort()).toEqual(["brew", "pour"]);
      // The record remembers where it came from — a URL, not a local path.
      expect(repo!.source).toContain("/s/remote-lib/docmodel.json");
      expect(listFederatedRepos(store)).toHaveLength(1);
    } finally {
      await close();
    }
  });

  it("uses the input verbatim when it already names a .json artifact", async () => {
    const repoDir = builtRepo("direct", [{ name: "x", desc: "X.", sig: "" }]);
    const body = fs.readFileSync(path.join(repoDir, "docmodel.json"), "utf8");
    const { base, close } = await serve(body);
    try {
      const store = tmpDir();
      const repo = await addFederatedRepoFromUrl(store, "direct", `${base}/custom/docmodel.json`);
      expect(repo!.source).toBe(`${base}/custom/docmodel.json`);
    } finally {
      await close();
    }
  });

  it("degrades to null on a non-2xx response or invalid JSON, without throwing", async () => {
    const store = tmpDir();
    const notFound = await serve('{"error":"nope"}', 404);
    try {
      expect(await addFederatedRepoFromUrl(store, "gone", notFound.base)).toBeNull();
    } finally {
      await notFound.close();
    }
    const bad = await serve("not a docmodel");
    try {
      expect(await addFederatedRepoFromUrl(store, "bad", bad.base)).toBeNull();
    } finally {
      await bad.close();
    }
    expect(listFederatedRepos(store)).toHaveLength(0);
  });
});
