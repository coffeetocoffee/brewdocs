import { describe, expect, it } from "vitest";
import { escapeHtml, safeUrl, escapeScriptJson } from "@brewdocs/core";

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

describe("escapeScriptJson (single source, INV-4)", () => {
  it("escapes all < to \\u003c so script tags and comment states cannot be opened or closed", () => {
    const raw = JSON.stringify({
      closeTag: "</script><script>alert(1)</script>",
      commentState: "<!--<script>",
    });
    const escaped = escapeScriptJson(raw);
    expect(escaped).not.toContain("<");
    expect(escaped).toContain("\\u003c/script>");
    expect(escaped).toContain("\\u003cscript>");
    expect(escaped).toContain("\\u003c!--\\u003cscript>");
    // Round-trips cleanly through JSON.parse
    expect(JSON.parse(escaped)).toEqual({
      closeTag: "</script><script>alert(1)</script>",
      commentState: "<!--<script>",
    });
  });
});
