import { describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  addOrgMember,
  aggregateOrgStats,
  canAccessOrg,
  createOrg,
  deleteOrg,
  getOrg,
  listOrgSites,
  listOrgs,
  orgOfSite,
  recordOrgSite,
  removeOrgMember,
} from "@brewdocs/core";

function tmp(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "brewdocs-cloud-"));
}

describe("v2.5 cloud control plane — orgs", () => {
  it("creates, lists, and deletes orgs (name taken -> null)", () => {
    const hosting = tmp();
    const org = createOrg(hosting, "Acme Co");
    expect(org?.name).toBe("acme-co");
    expect(createOrg(hosting, "acme-co")).toBeNull();
    expect(listOrgs(hosting).map((o) => o.name)).toEqual(["acme-co"]);
    expect(deleteOrg(hosting, "acme-co")).toBe(true);
    expect(listOrgs(hosting)).toEqual([]);
  });

  it("manages members and gates reads by key hash (raw keys accepted)", () => {
    const hosting = tmp();
    createOrg(hosting, "acme");
    expect(addOrgMember(hosting, "acme", "bd_live_abc123", { role: "admin", label: "owner" })).toBe(
      true,
    );
    expect(canAccessOrg(hosting, "acme", "bd_live_abc123")).toBe(true);
    expect(canAccessOrg(hosting, "acme", "bd_live_nope")).toBe(false);
    expect(canAccessOrg(hosting, "unknown", "bd_live_abc123")).toBe(false);
    const record = getOrg(hosting, "acme")!;
    expect(record.members[0]).toMatchObject({ role: "admin", label: "owner" });
    expect(record.members[0].keyHash).not.toContain("abc123");
    expect(removeOrgMember(hosting, "acme", "bd_live_abc123")).toBe(true);
    expect(canAccessOrg(hosting, "acme", "bd_live_abc123")).toBe(false);
  });

  it("tracks org-owned sites and resolves ownership", () => {
    const hosting = tmp();
    createOrg(hosting, "acme");
    recordOrgSite(hosting, "acme", "acme--lib");
    recordOrgSite(hosting, "acme", "acme--lib");
    expect(listOrgSites(hosting, "acme")).toEqual(["acme--lib"]);
    expect(orgOfSite(hosting, "acme--lib")).toBe("acme");
    expect(orgOfSite(hosting, "other")).toBeUndefined();
  });

  it("aggregates per-site counters into an org rollup", () => {
    const all = {
      "acme--a": { views: 10, builds: 2 },
      "acme--b": { views: 5, builds: 3 },
      other: { views: 99, builds: 99 },
    };
    expect(aggregateOrgStats(all, ["acme--a", "acme--b"])).toEqual({
      sites: ["acme--a", "acme--b"],
      views: 15,
      builds: 5,
    });
  });
});
