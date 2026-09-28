import { describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  buildRegistryGallery,
  getPlugin,
  installPlugin,
  listRegistryPlugins,
  loadPlugin,
  publishPlugin,
  registryEntryPath,
  searchPlugins,
  unpublishPlugin,
  verifyRegistry,
} from "@brewdocs/core";

function tmp(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

const PLUGIN_CJS = `module.exports = {
  name: "brewdocs-exclaim",
  onRender(html) {
    return html.replace("</footer>", "!</footer>");
  },
};
`;

function publishable(overrides: Record<string, unknown> = {}) {
  const reg = tmp("brewdocs-reg-");
  const file = path.join(reg, "plugin.cjs");
  fs.writeFileSync(file, PLUGIN_CJS, "utf8");
  const entry = publishPlugin(reg, file, {
    name: "exclaim",
    version: "1.0.0",
    kind: "plugin",
    description: "adds exclamation marks",
    keywords: ["fun"],
    ...overrides,
  });
  return { reg, file, entry };
}

describe("v3.0 plugin registry", () => {
  it("publishes, lists and searches entries", () => {
    const { reg, entry } = publishable();
    expect(entry).toBeTruthy();
    expect(entry!.name).toBe("exclaim");
    expect(listRegistryPlugins(reg).map((p) => p.name)).toEqual(["exclaim"]);
    expect(searchPlugins(reg, "exclamation").map((p) => p.name)).toEqual(["exclaim"]);
    expect(searchPlugins(reg, "zzz")).toEqual([]);
    expect(getPlugin(reg, "exclaim")?.version).toBe("1.0.0");
  });

  it("republish requires a newer version, keeping history", () => {
    const { reg, file } = publishable();
    expect(publishPlugin(reg, file, { name: "exclaim", version: "1.0.0" })).toBeNull();
    const v2 = publishPlugin(reg, file, { name: "exclaim", version: "1.1.0" });
    expect(v2?.version).toBe("1.1.0");
    expect(v2?.versions?.map((x) => x.version)).toEqual(["1.0.0", "1.1.0"]);
  });

  it("rejects non-plugin modules and bad names", () => {
    const reg = tmp("brewdocs-reg-");
    const junk = path.join(reg, "junk.cjs");
    fs.writeFileSync(junk, "console.log('just a script'); var x = 1;", "utf8");
    expect(publishPlugin(reg, junk, { name: "junk", version: "1.0.0" })).toBeNull();
    const { entry } = publishable();
    void entry;
    expect(publishPlugin(reg, junk, { name: "", version: "1.0.0" })).toBeNull();
  });

  it("installs into the source tree and loadPlugin resolves registry names", () => {
    const { reg } = publishable();
    const source = tmp("brewdocs-reg-src-");
    const result = installPlugin(reg, "exclaim", source);
    expect(result).toBeTruthy();
    expect(fs.existsSync(path.join(source, ".brewdocs", "plugins", "exclaim.cjs"))).toBe(true);
    expect(getPlugin(reg, "exclaim")!.installs).toBe(1);

    // installed spec loads through the normal relative-path route
    const installed = loadPlugin(result!.spec, source);
    expect(installed?.name).toBe("brewdocs-exclaim");

    // bare name loads straight from the registry (no install step)
    const viaRegistry = loadPlugin("exclaim", source, reg);
    expect(viaRegistry?.name).toBe("brewdocs-exclaim");
    expect(registryEntryPath(reg, "exclaim")).toContain("packages");
  });

  it("unpublish removes entries", () => {
    const { reg } = publishable();
    expect(unpublishPlugin(reg, "exclaim")).toBe(true);
    expect(unpublishPlugin(reg, "exclaim")).toBe(false);
    expect(listRegistryPlugins(reg)).toEqual([]);
  });

  it("renders a static marketplace gallery", () => {
    const { reg } = publishable();
    const out = tmp("brewdocs-reg-gallery-");
    const file = buildRegistryGallery(reg, out);
    const html = fs.readFileSync(file, "utf8");
    expect(html).toContain("exclaim");
    expect(html).toContain("brewdocs registry install exclaim");
    expect(html).toContain("<html lang=");
  });
});

// v4.4 registry integrity: a content hash recorded at publish makes the local
// store tamper-evident without a server.
describe("v4.4 registry integrity", () => {
  it("records a sha256 at publish and verifies clean", () => {
    const { reg } = publishable();
    expect(getPlugin(reg, "exclaim")!.integrity).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(verifyRegistry(reg)).toEqual([{ name: "exclaim", version: "1.0.0", status: "ok" }]);
  });

  it("detects a tampered entry and refuses to install or load it", () => {
    const { reg } = publishable();
    const entry = getPlugin(reg, "exclaim")!;
    const stored = path.join(reg, ...entry.entry.split("/"));
    fs.writeFileSync(stored, PLUGIN_CJS + "\n// tampered\n", "utf8");

    expect(verifyRegistry(reg)[0].status).toBe("mismatch");
    const source = tmp("brewdocs-reg-src-");
    expect(installPlugin(reg, "exclaim", source)).toBeNull();
    expect(registryEntryPath(reg, "exclaim")).toBeNull();
  });

  it("reports the true refusal reason so the CLI cannot call a tampered entry 'missing'", () => {
    const source = tmp("brewdocs-reg-src-");
    type Refusal = { reason?: "not-found" | "missing-file" | "integrity" };

    const notFound: Refusal = {};
    installPlugin(source, "ghost", source, notFound);
    expect(notFound.reason).toBe("not-found");

    const { reg } = publishable();
    const entry = getPlugin(reg, "exclaim")!;
    const stored = path.join(reg, ...entry.entry.split("/"));
    fs.writeFileSync(stored, PLUGIN_CJS + "\n// tampered\n", "utf8");

    const tampered: Refusal = {};
    installPlugin(reg, "exclaim", source, tampered);
    expect(tampered.reason).toBe("integrity");
  });
});
