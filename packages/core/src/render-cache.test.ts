import { describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  build,
  renderCached,
  renderCacheFile,
  renderFingerprint,
  type RenderModel,
} from "@brewdocs/core";

/**
 * v3.10 render cache: rendering is a pure function of (model, serializable
 * options), so an identical re-render must not run `produce` again, and any
 * model/option change must invalidate.
 */
function tmp(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "brewdocs-rc-"));
}

const model: RenderModel = {
  title: "t",
  frontmatter: {},
  sections: [],
  metadata: {},
  symbols: [],
};

describe("render cache", () => {
  it("reuses a cached page set without re-rendering", () => {
    const root = tmp();
    let calls = 0;
    const produce = () => {
      calls++;
      return [{ path: "index.html", html: "<h1>a</h1>" }];
    };
    const fp = renderFingerprint(model);

    const first = renderCached(root, fp, true, produce);
    const second = renderCached(root, fp, true, produce);

    expect(calls).toBe(1);
    expect(second).toEqual(first);
    expect(fs.existsSync(renderCacheFile(root))).toBe(true);
  });

  it("does not write a cache when disabled", () => {
    const root = tmp();
    renderCached(root, renderFingerprint(model), false, () => []);
    expect(fs.existsSync(renderCacheFile(root))).toBe(false);
  });

  it("invalidates when the model or options change", () => {
    const base = renderFingerprint(model);
    expect(renderFingerprint({ ...model, title: "other" })).not.toBe(base);
    expect(renderFingerprint(model, { theme: "ink" })).not.toBe(base);
    expect(renderFingerprint(model, { theme: "ink", dark: true })).not.toBe(
      renderFingerprint(model, { theme: "ink" }),
    );
  });

  it("build writes the render cache only when cache is on", () => {
    const root = tmp();
    fs.writeFileSync(path.join(root, "index.ts"), "export const x = 1;\n");
    fs.writeFileSync(
      path.join(root, "package.json"),
      JSON.stringify({ name: "rc", main: "index.ts" }),
    );

    build({ root, name: "rc" }, path.join(root, "out-off"), { cache: false });
    expect(fs.existsSync(renderCacheFile(root))).toBe(false);

    build({ root, name: "rc" }, path.join(root, "out-on"), { cache: true });
    expect(fs.existsSync(renderCacheFile(root))).toBe(true);
  });
});
