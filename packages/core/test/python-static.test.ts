import { describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { collectAdapters, loadPlugins, pythonStaticAdapter, type AdapterContext } from "@brewdocs/core";

function fixture(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "brewdocs-py-"));
  const pkg = path.join(root, "mylib");
  fs.mkdirSync(pkg);
  fs.writeFileSync(path.join(pkg, "__init__.py"), "");
  fs.writeFileSync(
    path.join(pkg, "core.py"),
    [
      '"""Module docs."""',
      "",
      'VERSION = "1.0"',
      "TIMEOUT: int = 30",
      "",
      "def greet(name: str, times: int = 1) -> str:",
      '    """Greet someone."""',
      "    return name * times",
      "",
      "def _private() -> None:",
      "    pass",
      "",
      "@deprecated",
      "class Brewery:",
      '    """A brewery."""',
      "    capacity: int = 0",
      "",
      "    def brew(self, cups: int) -> str:",
      '        return "brew"',
      "",
    ].join("\n"),
  );
  return root;
}

const ctx = (root: string, fetched = false): AdapterContext => ({ root, metadata: {}, fetched });

describe("v4.0 static Python extractor (no subprocess)", () => {
  it("extracts functions, constants, classes and methods", () => {
    const syms = pythonStaticAdapter.extract(ctx(fixture()));

    const greet = syms.find((s) => s.name === "greet");
    expect(greet?.kind).toBe("function");
    expect(greet?.description).toBe("Greet someone.");
    expect(greet?.params).toEqual([
      expect.objectContaining({ name: "name", type: "string" }),
      expect.objectContaining({ name: "times", type: "number", optional: true, default: "1" }),
    ]);
    expect(greet?.returns?.type).toBe("string");

    expect(syms.find((s) => s.name === "VERSION")?.kind).toBe("constant");
    expect(syms.find((s) => s.name === "TIMEOUT")?.signature).toBe("TIMEOUT: number");

    const brewery = syms.find((s) => s.name === "Brewery");
    expect(brewery?.kind).toBe("class");
    expect(brewery?.decorators).toEqual(["deprecated"]);
    expect(brewery?.members?.some((m) => m.name === "brew" && m.kind === "method")).toBe(true);

    // Leading underscore = private, never public API.
    expect(syms.some((s) => s.name === "_private")).toBe(false);
  });

  it("runs on a fetched source because it never executes anything", () => {
    const syms = pythonStaticAdapter.extract(ctx(fixture(), true));
    expect(syms.some((s) => s.name === "greet")).toBe(true);
  });

  it("python-ast opt-in replaces the static adapter (same id, user wins)", () => {
    const root = fixture();
    const adapters = collectAdapters(loadPlugins(["python-ast"], root));
    const pythons = adapters.filter((a) => a.id === "python");
    expect(pythons).toHaveLength(1);
    // The chosen one is the AST adapter: it refuses a fetched source.
    expect(pythons[0].extract(ctx(root, true))).toEqual([]);
  });

  it("default python adapter is the static one", () => {
    const py = collectAdapters([]).find((a) => a.id === "python");
    expect(py?.extract(ctx(fixture(), true)).length).toBeGreaterThan(0);
  });
});
