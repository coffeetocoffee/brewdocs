import { describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  addDomain,
  getDomain,
  listDomains,
  readTlsFile,
  removeDomain,
  verifyDomain,
  wellKnownPath,
} from "@brewdocs/core";

function tmp(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "brewdocs-dom-"));
}

describe("v2.5 custom domains", () => {
  it("claims a domain and hands out a verification token", () => {
    const hosting = tmp();
    const rec = addDomain(hosting, "Docs.Acme.com", "acme--lib")!;
    expect(rec.domain).toBe("docs.acme.com");
    expect(rec.subdomain).toBe("acme--lib");
    expect(rec.verified).toBe(false);
    expect(rec.token.startsWith("bd-verify-")).toBe(true);
    expect(wellKnownPath()).toBe("/.well-known/brewdocs.txt");
    expect(listDomains(hosting).map((d) => d.domain)).toEqual(["docs.acme.com"]);
  });

  it("rejects junk domains", () => {
    const hosting = tmp();
    expect(addDomain(hosting, "not a domain!", "x")).toBeNull();
    expect(addDomain(hosting, "docs.acme.com", "")).toBeNull();
  });

  it("verifies when the well-known file serves the token", async () => {
    const hosting = tmp();
    const rec = addDomain(hosting, "docs.acme.com", "lib")!;
    const ok = await verifyDomain(hosting, "docs.acme.com", async () => rec.token);
    expect(ok).toBe(true);
    expect(getDomain(hosting, "docs.acme.com")?.verified).toBe(true);
  });

  it("stays pending on mismatch, resolver errors, and unknown domains", async () => {
    const hosting = tmp();
    addDomain(hosting, "docs.acme.com", "lib");
    expect(await verifyDomain(hosting, "docs.acme.com", async () => "wrong")).toBe(false);
    expect(await verifyDomain(hosting, "docs.acme.com", async () => {
      throw new Error("dns down");
    })).toBe(false);
    expect(getDomain(hosting, "docs.acme.com")?.verified).toBe(false);
    expect(await verifyDomain(hosting, "missing.test", async () => "x")).toBe(false);
  });

  it("removes domains", () => {
    const hosting = tmp();
    addDomain(hosting, "docs.acme.com", "lib");
    expect(removeDomain(hosting, "docs.acme.com")).toBe(true);
    expect(listDomains(hosting)).toEqual([]);
    expect(removeDomain(hosting, "docs.acme.com")).toBe(false);
  });

  it("readTlsFile degrades to undefined for missing files", () => {
    expect(readTlsFile(path.join(tmp(), "nope.pem"))).toBeUndefined();
  });
});
