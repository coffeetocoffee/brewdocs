import { describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import {
  docModelSchemaJson,
  DOCMODEL_SCHEMA_ID,
  DOCMODEL_SCHEMA_OBJECT,
} from "./schema.js";
import { docModelArtifact } from "./docmodel.js";
import { buildModel } from "./build.js";

const EXAMPLES = path.resolve(__dirname, "../../../examples");
const libRoot = path.join(EXAMPLES, "lib");
const SCHEMA_FILE = path.resolve(__dirname, "../schemas/docmodel@1.schema.json");

describe("C.5 — published JSON Schema", () => {
  it("ships a checked-in copy that matches the source of truth", () => {
    expect(fs.existsSync(SCHEMA_FILE)).toBe(true);
    expect(fs.readFileSync(SCHEMA_FILE, "utf8")).toBe(docModelSchemaJson());
  });

  it("declares the public schema id", () => {
    expect(DOCMODEL_SCHEMA_ID).toBe(
      "https://brewdocs.dev/schemas/docmodel@1.schema.json",
    );
    expect(DOCMODEL_SCHEMA_OBJECT.$id).toBe(DOCMODEL_SCHEMA_ID);
  });

  it("requires the load-bearing artifact fields", () => {
    const required = DOCMODEL_SCHEMA_OBJECT.required as readonly string[];
    for (const field of ["schema", "generatedAt", "generator", "title", "symbols"]) {
      expect(required).toContain(field);
    }
  });

  it("describes every symbol the real artifact emits", () => {
    const artifact = docModelArtifact(buildModel({ root: libRoot, name: "lib" }));
    expect(artifact.symbols.length).toBeGreaterThan(0);
    const required = DOCMODEL_SCHEMA_OBJECT.$defs.symbol.required as readonly string[];
    for (const sym of artifact.symbols) {
      for (const field of required) {
        expect(sym).toHaveProperty(field);
      }
    }
  });

  it("rejects nothing the artifact emits: no stray top-level keys", () => {
    const artifact = docModelArtifact(buildModel({ root: libRoot, name: "lib" }));
    const allowed = new Set(
      Object.keys(DOCMODEL_SCHEMA_OBJECT.properties ?? {}),
    );
    for (const key of Object.keys(artifact)) {
      expect(allowed.has(key)).toBe(true);
    }
  });
});
