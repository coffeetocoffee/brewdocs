import { afterEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { buildDocModel } from "./docmodel.js";
import {
  addFederatedRepo,
  buildFederatedPage,
  listFederatedRepos,
  loadFederation,
  removeFederatedRepo,
  resolveDocModelPath,
  searchFederation,
} from "./federation.js";

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
});
