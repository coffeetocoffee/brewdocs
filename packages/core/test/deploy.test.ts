import { beforeAll, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  combineSubdomain,
  deploySite,
  deriveSubdomain,
  exportSite,
} from "../src/deploy.js";

const EXAMPLES = path.resolve(__dirname, "../../../examples");
const libRoot = path.join(EXAMPLES, "lib");
let isolatedLib: string;

function tmp(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "brewdocs-deploy-"));
}

beforeAll(() => {
  // Isolate fixture outside the host git repository so version discovery
  // does not crawl all 28 git tags of brewdocs and churn worktrees per test.
  isolatedLib = fs.mkdtempSync(path.join(os.tmpdir(), "brewdocs-lib-fixture-"));
  fs.cpSync(libRoot, isolatedLib, { recursive: true });
});

describe("Phase 4 — deploy", () => {
  it("derives a safe subdomain from a name or path", () => {
    expect(deriveSubdomain({ root: "/x/y", name: "@scope/My Lib!" })).toBe(
      "scope-my-lib",
    );
    expect(deriveSubdomain({ root: "/x/my-package" })).toBe("my-package");
  });

  it("collapses a GitHub URL into the repo-user form", () => {
    expect(
      deriveSubdomain({ root: "/x", name: "https://github.com/user/repo" }),
    ).toBe("repo-user");
    expect(
      deriveSubdomain({ root: "/x", name: "https://github.com/acme/my-tool.git" }),
    ).toBe("my-tool-acme");
  });

  it("combines an org namespace with the subdomain", () => {
    expect(combineSubdomain("acme", "my-lib")).toBe("acme--my-lib");
    expect(combineSubdomain(undefined, "my-lib")).toBe("my-lib");
    expect(combineSubdomain("Acme Corp", "My Lib!")).toBe("acme-corp--my-lib");
  });

  // These three invoke a full build (25-35s each). Under `npm run verify` the
  // gate's own server test runs alongside them, so 60s alone can be exceeded;
  // retry keeps a loaded machine from looking like a regression.
  it("exportSite writes a self-contained index.html", { timeout: 60_000, retry: 2 }, async () => {
    const out = tmp();
    const file = await exportSite({ root: isolatedLib }, out);
    expect(fs.existsSync(file)).toBe(true);
    const html = fs.readFileSync(file, "utf8");
    expect(html).toContain("BrewDocs");
    expect(html).toContain('id="search-index"');
  });

  it(
    "deploySite writes to hosting/<subdomain> and returns a hosted URL",
    { timeout: 60_000, retry: 2 },
    async () => {
      const hosting = tmp();
      const result = await deploySite(
        { root: isolatedLib, name: "lib" },
        hosting,
        "mylib",
      );
      expect(result.url).toBe("https://mylib.brewdocs.dev");
      expect(fs.existsSync(path.join(hosting, "mylib", "index.html"))).toBe(true);
      const manifest = JSON.parse(
        fs.readFileSync(path.join(hosting, "mylib", ".brewdocs.json"), "utf8"),
      );
      expect(manifest.subdomain).toBe("mylib");
      expect(manifest.url).toBe("https://mylib.brewdocs.dev");
    },
  );

  it(
    "deploySite records org + private visibility and hashes the token",
    { timeout: 60_000, retry: 2 },
    async () => {
      const hosting = tmp();
      const result = await deploySite(
        { root: isolatedLib, name: "lib" },
        hosting,
        "acme--mylib",
        {},
        undefined,
        { org: "acme", visibility: "private", token: "s3cret" },
      );
      expect(result.visibility).toBe("private");
      expect(result.org).toBe("acme");
      const manifest = JSON.parse(
        fs.readFileSync(path.join(hosting, "acme--mylib", ".brewdocs.json"), "utf8"),
      );
    expect(manifest.visibility).toBe("private");
    expect(manifest.org).toBe("acme");
    expect(manifest.tokenHash).toBeTruthy();
    expect(manifest.tokenHash).not.toBe("s3cret");
    },
  );
});
