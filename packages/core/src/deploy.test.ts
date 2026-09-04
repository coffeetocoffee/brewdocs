import { describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { deploySite, deriveSubdomain, exportSite } from "./deploy.js";

const EXAMPLES = path.resolve(__dirname, "../../../examples");
const libRoot = path.join(EXAMPLES, "lib");

function tmp(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "brewdocs-deploy-"));
}

describe("Phase 4 — deploy", () => {
  it("derives a safe subdomain from a name or path", () => {
    expect(deriveSubdomain({ root: "/x/y", name: "@scope/My Lib!" })).toBe(
      "scope-my-lib",
    );
    expect(deriveSubdomain({ root: "/x/my-package" })).toBe("my-package");
  });

  it("exportSite writes a self-contained index.html", async () => {
    const out = tmp();
    const file = await exportSite({ root: libRoot }, out);
    expect(fs.existsSync(file)).toBe(true);
    const html = fs.readFileSync(file, "utf8");
    expect(html).toContain("BrewDocs");
    expect(html).toContain('id="search-index"');
  });

  it("deploySite writes to hosting/<subdomain> and returns a hosted URL", async () => {
    const hosting = tmp();
    const result = await deploySite(
      { root: libRoot, name: "lib" },
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
  });
});
