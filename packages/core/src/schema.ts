/**
 * Published JSON Schema for the DocModel artifact (`brewdocs/docmodel@1`).
 *
 * Single source of truth is `DOCMODEL_SCHEMA_OBJECT` here; the checked-in
 * copy at `schemas/docmodel@1.schema.json` must match it byte-for-byte
 * (verified in `schema.test.ts`) so the package ships a stable,
 * validator-consumable contract and the README can link to it.
 */

export const DOCMODEL_SCHEMA_ID =
  "https://brewdocs.dev/schemas/docmodel@1.schema.json";

/** JSON Schema (draft 2020-12) for `docmodel.json`. */
export const DOCMODEL_SCHEMA_OBJECT = {
  $id: DOCMODEL_SCHEMA_ID,
  $schema: "https://json-schema.org/draft/2020-12/schema",
  title: "BrewDocs DocModel",
  description:
    "Machine-readable API knowledge: exported symbols, resolved types, params, examples, deprecations, coverage, and a freshness stamp.",
  type: "object",
  required: ["schema", "generatedAt", "generator", "title", "symbols"],
  properties: {
    schema: {
      const: "brewdocs/docmodel@1",
      description: "Versioned schema id so consumers can pin and evolve safely.",
    },
    generatedAt: {
      type: "string",
      format: "date-time",
      description: "Build date (ISO 8601) — part of the freshness stamp.",
    },
    generator: {
      type: "object",
      required: ["name", "version"],
      properties: {
        name: { type: "string" },
        version: { type: "string" },
      },
      additionalProperties: false,
    },
    package: {
      type: "object",
      properties: {
        name: { type: "string" },
        version: { type: "string" },
        description: { type: "string" },
        license: { type: "string" },
        homepage: { type: "string" },
        repository: { type: "string" },
        keywords: { type: "array", items: { type: "string" } },
      },
      additionalProperties: false,
    },
    version: {
      type: "string",
      description:
        "The version this artifact describes (package version, or an explicit override for versioned builds). Consumer must treat docs as stale when it differs from the running code version.",
    },
    source: {
      type: "object",
      properties: {
        gitSha: { type: "string" },
      },
      additionalProperties: false,
    },
    coverage: {
      type: "object",
      properties: {
        score: { type: "number", minimum: 0, maximum: 100 },
        totalSymbols: { type: "integer", minimum: 0 },
        documentedSymbols: { type: "integer", minimum: 0 },
        paramsTotal: { type: "integer", minimum: 0 },
        paramsDocumented: { type: "integer", minimum: 0 },
        returnsTotal: { type: "integer", minimum: 0 },
        returnsDocumented: { type: "integer", minimum: 0 },
        examplesTotal: { type: "integer", minimum: 0 },
      },
      additionalProperties: false,
    },
    title: { type: "string" },
    description: { type: "string" },
    symbols: {
      type: "array",
      items: { $ref: "#/$defs/symbol" },
    },
  },
  additionalProperties: false,
  $defs: {
    param: {
      type: "object",
      required: ["name"],
      properties: {
        name: { type: "string" },
        type: { type: "string" },
        description: { type: "string" },
        optional: { type: "boolean" },
        default: { type: "string" },
      },
      additionalProperties: false,
    },
    member: {
      type: "object",
      required: ["name", "kind"],
      properties: {
        name: { type: "string" },
        kind: { enum: ["method", "property", "constructor"] },
        signature: { type: "string" },
        description: { type: "string" },
        type: { type: "string" },
        optional: { type: "boolean" },
        static: { type: "boolean" },
        readonly: { type: "boolean" },
        visibility: { enum: ["public", "private", "protected"] },
        deprecated: { type: ["string", "boolean"] },
      },
      additionalProperties: false,
    },
    symbol: {
      type: "object",
      required: ["name", "kind", "params", "examples"],
      properties: {
        name: { type: "string" },
        kind: {
          enum: ["function", "class", "interface", "type", "constant", "unknown"],
        },
        signature: { type: "string" },
        description: { type: "string" },
        params: {
          type: "array",
          items: { $ref: "#/$defs/param" },
        },
        returns: {
          type: "object",
          properties: {
            type: { type: "string" },
            description: { type: "string" },
          },
          additionalProperties: false,
        },
        examples: { type: "array", items: { type: "string" } },
        deprecated: { type: ["string", "boolean"] },
        sourceFile: { type: "string" },
        members: {
          type: "array",
          items: { $ref: "#/$defs/member" },
        },
        typeParams: {
          type: "array",
          items: {
            type: "object",
            required: ["name"],
            properties: {
              name: { type: "string" },
              constraint: { type: "string" },
              default: { type: "string" },
            },
            additionalProperties: false,
          },
        },
        throws: { type: "array", items: { type: "string" } },
        see: { type: "array", items: { type: "string" } },
        resolvedParams: { type: "array", items: { type: "string" } },
        resolvedReturn: { type: "string" },
        replacements: { type: "array", items: { type: "string" } },
      },
      additionalProperties: false,
    },
  },
} as const;

/** Pretty-printed schema JSON with trailing newline (what ships). */
export function docModelSchemaJson(): string {
  return JSON.stringify(DOCMODEL_SCHEMA_OBJECT, null, 2) + "\n";
}
