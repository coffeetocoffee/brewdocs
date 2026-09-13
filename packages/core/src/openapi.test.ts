import { describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { buildModel, openApiAdapter, graphqlAdapter } from "@brewdocs/core";

function tmpPkg(files: Record<string, string>): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "brewdocs-api-"));
  for (const [name, content] of Object.entries(files)) {
    fs.writeFileSync(path.join(dir, name), content, "utf8");
  }
  return dir;
}

const OPENAPI_JSON = JSON.stringify({
  openapi: "3.0.3",
  info: { title: "Pet API", version: "1.0.0" },
  paths: {
    "/pets": {
      get: {
        operationId: "listPets",
        summary: "List all pets",
        parameters: [
          { name: "limit", in: "query", required: false, schema: { type: "integer" } },
        ],
        responses: {
          "200": {
            description: "ok",
            content: { "application/json": { schema: { type: "array", items: { $ref: "#/components/schemas/Pet" } } } },
          },
        },
      },
      post: {
        summary: "Create a pet",
        requestBody: {
          required: true,
          content: { "application/json": { schema: { $ref: "#/components/schemas/NewPet" } } },
        },
        responses: { "201": { description: "created" } },
      },
    },
    "/pets/{petId}": {
      get: {
        deprecated: true,
        parameters: [{ name: "petId", in: "path", required: true, schema: { type: "string" } }],
        responses: { "200": { description: "ok" } },
      },
    },
  },
  components: {
    schemas: {
      Pet: { type: "object", properties: { id: { type: "string" }, name: { type: "string" } } },
      NewPet: { type: "object", properties: { name: { type: "string" } } },
    },
  },
});

const OPENAPI_YAML = `openapi: 3.0.3
info:
  title: Task API
  version: "2.0.0"
paths:
  /tasks:
    get:
      operationId: listTasks
      summary: List tasks
      parameters:
        - name: done
          in: query
          required: false
          schema:
            type: boolean
      responses:
        "200":
          description: ok
          content:
            application/json:
              schema:
                type: array
                items:
                  $ref: "#/components/schemas/Task"
    post:
      summary: Create task
      requestBody:
        required: true
        content:
          application/json:
            schema:
              $ref: "#/components/schemas/TaskInput"
      responses:
        "201":
          description: created
components:
  schemas:
    Task:
      type: object
      properties:
        id:
          type: string
        title:
          type: string
    TaskInput:
      type: object
      properties:
        title:
          type: string
`;

const GRAPHQL_SCHEMA = `"""\nRoot queries.\n"""
type Query {
  "All users"
  users(limit: Int = 10): [User!]!
  user(id: ID!): User
}

type Mutation {
  createUser(input: CreateUserInput!): User!
}

"""A platform user."""
type User {
  id: ID!
  name: String!
  email: String
  posts(first: Int): [Post!]!
}

interface Node {
  id: ID!
}

input CreateUserInput {
  name: String!
  email: String!
}

enum Role {
  ADMIN
  MEMBER
}

scalar DateTime

union SearchHit = User | Post

type Post {
  id: ID!
  title: String!
}
`;

describe("v2.5 OpenAPI extractor", () => {
  it("extracts operations from a JSON spec with params, returns, deprecation", () => {
    const root = tmpPkg({ "openapi.json": OPENAPI_JSON });
    const model = buildModel({ root });
    const names = model.symbols.map((s) => s.name).sort();
    expect(names).toEqual(["getPetsPetId", "listPets", "postPets"]);

    const list = model.symbols.find((s) => s.name === "listPets")!;
    expect(list.kind).toBe("function");
    expect(list.signature).toBe("GET /pets");
    expect(list.description).toBe("List all pets");
    expect(list.params).toEqual([
      { name: "limit", type: "integer", optional: true },
    ]);
    expect(list.returns?.type).toBe("Pet[]");

    const post = model.symbols.find((s) => s.name === "postPets")!;
    expect(post.params.some((p) => p.name === "body" && p.type === "NewPet")).toBe(true);

    const dep = model.symbols.find((s) => s.name === "getPetsPetId")!;
    expect(dep.deprecated).toBe(true);
    expect(dep.params[0]).toMatchObject({ name: "petId", optional: false });
  });

  it("extracts operations from a YAML spec (mini parser, block seq params)", () => {
    const root = tmpPkg({ "openapi.yaml": OPENAPI_YAML });
    const model = buildModel({ root });
    const list = model.symbols.find((s) => s.name === "listTasks");
    expect(list?.description).toBe("List tasks");
    expect(list?.params).toEqual([{ name: "done", type: "boolean", optional: true }]);
    expect(list?.returns?.type).toBe("Task[]");
    expect(model.symbols.map((s) => s.name).sort()).toEqual(["listTasks", "postTasks"]);
  });

  it("degrades gracefully on malformed specs", () => {
    const root = tmpPkg({ "openapi.json": "{not json at all" });
    const model = buildModel({ root });
    expect(model.symbols).toEqual([]);
  });

  it("detects only via spec files at the source root", () => {
    const root = tmpPkg({ "openapi.yml": "{}" });
    expect(openApiAdapter.detect({ root, metadata: {} })).toBe(true);
    const empty = fs.mkdtempSync(path.join(os.tmpdir(), "brewdocs-plain-"));
    expect(openApiAdapter.detect({ root: empty, metadata: {} })).toBe(false);
  });
});

describe("v2.5 GraphQL extractor", () => {
  it("extracts types as symbols and root fields as functions", () => {
    const root = tmpPkg({ "schema.graphql": GRAPHQL_SCHEMA });
    const model = buildModel({ root });
    const byName = new Map(model.symbols.map((s) => [s.name, s]));

    expect(byName.get("User")?.kind).toBe("class");
    expect(byName.get("User")?.description).toContain("platform user");
    expect(byName.get("Node")?.kind).toBe("interface");
    expect(byName.get("CreateUserInput")?.kind).toBe("class");
    expect(byName.get("Role")?.members?.map((m) => m.name)).toEqual(["ADMIN", "MEMBER"]);
    expect(byName.get("DateTime")?.kind).toBe("type");
    expect(byName.get("Post")).toBeTruthy();

    const users = byName.get("Query.users")!;
    expect(users.kind).toBe("function");
    expect(users.description).toBe("All users");
    expect(users.params).toEqual([{ name: "limit", type: "Int", optional: true }]);
    expect(users.returns?.type).toBe("User");

    const create = byName.get("Mutation.createUser")!;
    expect(create.params).toEqual([{ name: "input", type: "CreateUserInput", optional: false }]);
    expect(create.returns?.type).toBe("User");

    const fieldMember = byName.get("User")?.members?.find((m) => m.name === "posts");
    expect(fieldMember?.signature).toBe("posts(first: Int): [Post!]!");
  });

  it("merges multiple .graphql files and dedupes names", () => {
    const root = tmpPkg({
      "a.graphql": "type Thing { id: ID! }",
      "b.gql": "type Thing { id: ID! }\ntype Other { name: String }",
    });
    const model = buildModel({ root });
    expect(model.symbols.map((s) => s.name).sort()).toEqual(["Other", "Thing"]);
  });

  it("detects schemas at the root only", () => {
    const root = tmpPkg({ "schema.graphql": "scalar X" });
    expect(graphqlAdapter.detect({ root, metadata: {} })).toBe(true);
    const empty = fs.mkdtempSync(path.join(os.tmpdir(), "brewdocs-plain2-"));
    expect(graphqlAdapter.detect({ root: empty, metadata: {} })).toBe(false);
  });
});
