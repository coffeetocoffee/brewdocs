import { describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  buildDocModel,
  docModelArtifact,
  renderDocModelJson,
  DOCMODEL_SCHEMA,
} from "./docmodel.js";
import { buildModel } from "./build.js";

const EXAMPLES = path.resolve(__dirname, "../../../examples");
const libRoot = path.join(EXAMPLES, "lib");

function tmp(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "brewdocs-dm-"));
}

describe("Direction C — docmodel.json artifact", () => {
  it("produces a versioned, self-describing artifact", () => {
    const model = buildModel({ root: libRoot, name: "lib" });
    const artifact = docModelArtifact(model, {
      generatedAt: "2026-09-05T00:00:00.000Z",
      generatorVersion: "0.0.0-test",
    });
    expect(artifact.schema).toBe(DOCMODEL_SCHEMA);
    expect(artifact.generatedAt).toBe("2026-09-05T00:00:00.000Z");
    expect(artifact.generator).toEqual({ name: "brewdocs", version: "0.0.0-test" });
  });

  it("carries the package block, symbols, and coverage", () => {
    const model = buildModel({ root: libRoot, name: "lib" });
    const artifact = docModelArtifact(model);
    expect(artifact.package?.name).toBe("lib");
    expect(artifact.package?.version).toBe("1.2.0");
    expect(artifact.package?.keywords).toContain("docs");
    expect(artifact.title).toBe("lib");
    // Version awareness: the artifact states which version it describes.
    expect(artifact.version).toBe("1.2.0");
    expect(artifact.symbols.length).toBe(model.symbols.length);
    expect(artifact.symbols.length).toBeGreaterThan(0);
    expect(typeof artifact.coverage?.score).toBe("number");
    // Resolved types + params survive into the artifact for machine consumers.
    const withParams = artifact.symbols.find((s) => s.params.length > 0);
    expect(withParams).toBeTruthy();
  });

  it("allows a version override for versioned builds", () => {
    const model = buildModel({ root: libRoot, name: "lib" });
    const artifact = docModelArtifact(model, { version: "3.0.0-beta.1" });
    expect(artifact.version).toBe("3.0.0-beta.1");
  });

  it("stamps the git sha when provided (freshness metadata)", () => {
    const model = buildModel({ root: libRoot, name: "lib" });
    const stamped = docModelArtifact(model, { gitSha: "abc123" });
    expect(stamped.source?.gitSha).toBe("abc123");
    const bare = docModelArtifact(model);
    expect(bare.source?.gitSha).toBeUndefined();
  });

  it("buildDocModel writes docmodel.json and detects the source repo sha", () => {
    const out = tmp();
    const file = buildDocModel({ root: libRoot, name: "lib" }, out);
    expect(path.basename(file)).toBe("docmodel.json");
    expect(fs.existsSync(file)).toBe(true);
    const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as {
      schema: string;
      generator: { name: string };
      source?: { gitSha?: string };
      symbols: unknown[];
    };
    expect(parsed.schema).toBe(DOCMODEL_SCHEMA);
    expect(parsed.generator.name).toBe("brewdocs");
    expect(Array.isArray(parsed.symbols)).toBe(true);
    // examples/ lives inside the brewdocs repo, so a sha is expected —
    // but stay tolerant of detached checkouts.
    if (parsed.source) expect(parsed.source.gitSha).toMatch(/^[0-9a-f]{7,40}$/);
  });

  it("renderDocModelJson emits pretty JSON with a trailing newline", () => {
    const model = buildModel({ root: libRoot, name: "lib" });
    const json = renderDocModelJson(model, { generatedAt: "2026-09-05T00:00:00.000Z" });
    expect(json.endsWith("\n")).toBe(true);
    expect(json).toContain('"schema": "brewdocs/docmodel@1"');
    expect(JSON.parse(json)).toBeTruthy();
  });
});
