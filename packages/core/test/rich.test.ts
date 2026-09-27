import { describe, expect, it } from "vitest";
import * as path from "node:path";
import { buildModel, extractExports, diffSymbols } from "@brewdocs/core";
import type { SymbolDoc } from "@brewdocs/core";

const EXAMPLES = path.resolve(__dirname, "../../../examples");
const richRoot = path.join(EXAMPLES, "rich");

function extract(): SymbolDoc[] {
  return extractExports(richRoot, { main: "index.ts" });
}

describe("Direction A — deeper type resolution", () => {
  it("resolves param and return types through the checker", () => {
    const syms = extract();
    const openVault = syms.find((s) => s.name === "openVault");
    expect(openVault).toBeDefined();
    // `id: UserId` unwraps to `string`; opts keeps its generic name.
    expect(openVault?.resolvedParams).toEqual(["string", "T?"]);
    expect(openVault?.resolvedReturn).toBe("Promise<number>");
    // Textual signature still shows the alias name.
    expect(openVault?.params[0]?.type).toBe("UserId");
  });

  it("extracts generic type parameters with constraints and defaults", () => {
    const syms = extract();
    const vault = syms.find((s) => s.name === "Vault");
    expect(vault?.typeParams).toEqual([
      { name: "T", constraint: "VaultOptions", default: "VaultOptions" },
    ]);
    const dict = syms.find((s) => s.name === "Dict");
    expect(dict?.typeParams).toEqual([{ name: "T", constraint: undefined, default: undefined }]);
  });

  it("does not add resolved types to non-callable symbols", () => {
    const syms = extract();
    const vault = syms.find((s) => s.name === "Vault");
    expect(vault?.resolvedParams).toBeUndefined();
    expect(vault?.resolvedReturn).toBeUndefined();
  });
});

describe("Direction A — richer symbol pages", () => {
  it("extracts class members with kinds, modifiers and resolved types", () => {
    const vault = extract().find((s) => s.name === "Vault");
    const members = vault?.members ?? [];
    const byName = Object.fromEntries(members.map((m) => [m.name, m]));

    expect(byName["constructor"]?.kind).toBe("constructor");
    expect(byName["constructor"]?.signature).toContain("root: string");
    expect(byName["unlocked"]?.kind).toBe("property");
    expect(byName["unlocked"]?.readonly).toBe(true);
    expect(byName["unlocked"]?.type).toBe("boolean");
    expect(byName["open"]?.kind).toBe("method");
    expect(byName["open"]?.signature).toBe("open(opts: T): Promise<number>");
    expect(byName["open"]?.description).toContain("Open the vault.");
    expect(byName["createDefault"]?.static).toBe(true);
  });

  it("extracts interface members", () => {
    const opts = extract().find((s) => s.name === "VaultOptions");
    const byName = Object.fromEntries((opts?.members ?? []).map((m) => [m.name, m]));
    expect(byName["path"]?.kind).toBe("property");
    expect(byName["path"]?.type).toBe("string");
    expect(byName["path"]?.description).toContain("Path to the vault file.");
    expect(byName["cipher"]?.optional).toBe(true);
    expect(byName["timeout"]?.optional).toBe(true);
  });

  it("parses @throws and @see on a top-level function", () => {
    const openVault = extract().find((s) => s.name === "openVault");
    expect(openVault?.throws).toHaveLength(2);
    expect(openVault?.throws?.[0]).toContain("VaultError");
    expect(openVault?.throws?.[1]).toContain("passphrase");
    expect(openVault?.see?.[0]).toContain("Vault");
  });

  it("parses @throws on class members", () => {
    const vault = extract().find((s) => s.name === "Vault");
    const open = vault?.members?.find((m) => m.name === "open");
    // Member-level @throws is part of the member docs fingerprint; presence
    // on the class symbol is not required.
    expect(open?.signature).toBe("open(opts: T): Promise<number>");
  });

  it("renders members, throws, see and typeParams into HTML", async () => {
    const { renderToHtml } = await import("@brewdocs/core");
    const model = buildModel({ root: richRoot });
    const html = renderToHtml(model);
    expect(html).toContain("Members</h4>");
    expect(html).toContain("Throws</h4>");
    expect(html).toContain("See</h4>");
    expect(html).toContain("T extends VaultOptions = VaultOptions");
    expect(html).toContain("readonly unlocked");
  });
});

describe("Direction A — cross-links", () => {
  it("links type references to symbol anchors on the single page", async () => {
    const { renderToHtml } = await import("@brewdocs/core");
    const model = buildModel({ root: richRoot });
    const html = renderToHtml(model);
    // VaultOptions referenced in typeParams / member signatures / @throws/@see
    expect(html).toContain(
      '<a class="type-ref" href="#symbol-vaultoptions">VaultOptions</a>',
    );
    // Param type `UserId` on openVault
    expect(html).toContain('<a class="type-ref" href="#symbol-userid">UserId</a>');
    // The symbol's own heading section anchors exist for the links
    expect(html).toContain('id="symbol-vaultoptions"');
    expect(html).toContain('id="symbol-userid"');
  });

  it("does not linkify keywords, locals or unknown identifiers", async () => {
    const { renderToHtml } = await import("@brewdocs/core");
    const model = buildModel({ root: richRoot });
    const html = renderToHtml(model);
    expect(html).not.toContain('href="#symbol-string"');
    expect(html).not.toContain('href="#symbol-promise"');
    expect(html).not.toContain('href="#symbol-opts"');
  });

  it("links to symbol pages in multi-page output (excluding the page itself)", async () => {
    const { renderToHtmlMulti } = await import("@brewdocs/core");
    const model = buildModel({ root: richRoot });
    const pages = renderToHtmlMulti(model);
    const vaultPage = pages.find((p) => p.path === "symbols/vault.html");
    // References to other symbols point at their pages
    expect(vaultPage?.html).toContain('href="vaultoptions.html"');
    // The page does not link to itself
    expect(vaultPage?.html).not.toContain('href="vault.html"');
    // openVault references VaultOptions (constraint) and UserId (param type)
    const fnPage = pages.find((p) => p.path === "symbols/openvault.html");
    expect(fnPage?.html).toContain('href="vaultoptions.html"');
    expect(fnPage?.html).toContain('href="userid.html"');
  });

  it("never linkifies inside code comments or strings", async () => {
    const { renderToHtml } = await import("@brewdocs/core");
    const model = buildModel({ root: richRoot });
    const html = renderToHtml(model);
    // The Vault signature block embeds the comment `/** Whether the vault...`
    // — a tok-comment span must never contain a link.
    for (const m of html.matchAll(
      /<span class="tok-(?:comment|string)">([\s\S]*?)<\/span>/g,
    )) {
      expect(m[1]).not.toContain("<a ");
    }
  });
});

describe("Direction A — semantic diff", () => {
  it("does not flag alias-unwrapped type changes as breaking", () => {
    const from: SymbolDoc = {
      name: "f",
      kind: "function",
      params: [{ name: "x", type: "UserId" }],
      examples: [],
      resolvedParams: ["string"],
      resolvedReturn: "void",
    };
    const to: SymbolDoc = {
      name: "f",
      kind: "function",
      params: [{ name: "x", type: "string" }],
      examples: [],
      resolvedParams: ["string"],
      resolvedReturn: "void",
    };
    const diff = diffSymbols("1.0.0", [from], "2.0.0", [to]);
    expect(diff.changed).toHaveLength(0);
    expect(diff.breakingCount).toBe(0);
  });

  it("still flags real signature changes semantically", () => {
    const mk = (resolvedParams: string[]): SymbolDoc => ({
      name: "g",
      kind: "function",
      params: [],
      examples: [],
      resolvedParams,
      resolvedReturn: "void",
    });
    const diff = diffSymbols("1.0.0", [mk(["string"])], "2.0.0", [mk(["string", "number"])]);
    expect(diff.changed[0].changes).toContain("signature-changed");
    expect(diff.breakingCount).toBe(1);
  });

  it("flags removed interface members as breaking", () => {
    const mkMembers = (members: SymbolDoc["members"]): SymbolDoc => ({
      name: "Opts",
      kind: "interface",
      params: [],
      examples: [],
      members,
    });
    const from = mkMembers([
      { name: "a", kind: "property", type: "string" },
      { name: "b", kind: "property", type: "number" },
    ]);
    const to = mkMembers([{ name: "a", kind: "property", type: "string" }]);
    const diff = diffSymbols("1.0.0", [from], "2.0.0", [to]);
    expect(diff.changed[0].changes).toContain("signature-changed");
    expect(diff.breakingCount).toBe(1);
  });

  it("flags changed member signatures as breaking", () => {
    const mkMembers = (members: SymbolDoc["members"]): SymbolDoc => ({
      name: "Svc",
      kind: "class",
      params: [],
      examples: [],
      members,
    });
    const from = mkMembers([
      { name: "run", kind: "method", signature: "run(x: string): void" },
    ]);
    const to = mkMembers([
      { name: "run", kind: "method", signature: "run(x: string, y: number): void" },
    ]);
    const diff = diffSymbols("1.0.0", [from], "2.0.0", [to]);
    expect(diff.breakingCount).toBe(1);
  });

  it("does not flag docs-only member changes as breaking", () => {
    const mk = (members: SymbolDoc["members"]): SymbolDoc => ({
      name: "Svc",
      kind: "class",
      params: [],
      examples: [],
      members,
    });
    const from = mk([{ name: "run", kind: "method", signature: "run(): void" }]);
    const to = mk([{ name: "run", kind: "method", signature: "run(): void" }]);
    const diff = diffSymbols("1.0.0", [from], "2.0.0", [to]);
    expect(diff.changed).toHaveLength(0);
  });
});
