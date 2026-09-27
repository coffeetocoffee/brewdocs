import { describe, expect, it } from "vitest";
import { escapeHtml, safeUrl } from "@brewdocs/core";

describe("escapeHtml (single source, INV-4)", () => {
  it("escapes &, <, > and both quote characters", () => {
    expect(escapeHtml(`<a href="x" onclick='y'>&`)).toBe(
      "&lt;a href=&quot;x&quot; onclick=&#39;y&#39;&gt;&amp;",
    );
  });

  it("is safe when interpolated into a quoted attribute", () => {
    const payload = `x" onmouseover="alert(1)`;
    expect(escapeHtml(payload)).not.toContain(`"`);
    expect(escapeHtml(payload)).toContain("&quot;");
  });
});

describe("safeUrl (INV-7)", () => {
  it("drops script-bearing schemes, including control-char-smuggled forms", () => {
    expect(safeUrl("javascript:alert(1)")).toBeUndefined();
    expect(safeUrl("JAVASCRIPT:alert(1)")).toBeUndefined();
    expect(safeUrl("java\nscript:alert(1)")).toBeUndefined();
    expect(safeUrl("data:text/html,x")).toBeUndefined();
    expect(safeUrl("vbscript:x")).toBeUndefined();
  });

  it("keeps ordinary URLs and returns them trimmed", () => {
    expect(safeUrl("  https://example.com/a  ")).toBe("https://example.com/a");
    expect(safeUrl("/relative/path")).toBe("/relative/path");
  });
});
