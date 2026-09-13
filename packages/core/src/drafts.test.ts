import { describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { deploySite, setDraftExpiry, draftExpired } from "@brewdocs/core";

const TINY = path.resolve(__dirname, "../../../examples/tiny");

describe("v1.2 private drafts — deploy --draft", () => {
  it("records draft + expiry in the manifest and prints a token URL", async () => {
    const hosting = fs.mkdtempSync(path.join(os.tmpdir(), "brewdocs-draft-"));
    const expires = new Date(Date.now() + 3600_000).toISOString();
    await deploySite({ root: TINY }, hosting, "preview", undefined, undefined, {
      visibility: "private",
      token: "s3cret",
      draft: true,
      draftExpires: expires,
    });

    const manifest = JSON.parse(
      fs.readFileSync(path.join(hosting, "preview", ".brewdocs.json"), "utf8"),
    ) as { visibility: string; draft?: boolean; draftExpires?: string };
    expect(manifest.visibility).toBe("private");
    expect(manifest.draft).toBe(true);
    expect(manifest.draftExpires).toBe(expires);
    expect(draftExpired(manifest)).toBe(false);
  });

  it("rejects --draft without private visibility", async () => {
    const hosting = fs.mkdtempSync(path.join(os.tmpdir(), "brewdocs-draft2-"));
    await expect(
      deploySite({ root: TINY }, hosting, "oops", undefined, undefined, {
        draft: true,
      }),
    ).rejects.toThrow(/--draft requires --private/);
  });
});

describe("v1.2 private drafts — expiry / revocation", () => {
  it("extends and revokes via the manifest (keys-style management)", async () => {
    const hosting = fs.mkdtempSync(path.join(os.tmpdir(), "brewdocs-draft3-"));
    await deploySite({ root: TINY }, hosting, "d", undefined, undefined, {
      visibility: "private",
      token: "tok",
      draft: true,
      draftExpires: new Date(Date.now() + 1000).toISOString(),
    });

    // Expired in the past -> draftExpired flips true.
    const expiredManifest = {
      draft: true,
      draftExpires: new Date(Date.now() - 1000).toISOString(),
    };
    expect(draftExpired(expiredManifest)).toBe(true);
    // Non-drafts never expire.
    expect(draftExpired({ draft: false })).toBe(false);

    // Extend it into the future.
    const later = new Date(Date.now() + 7200_000).toISOString();
    expect(setDraftExpiry(hosting, "d", later)).toBe(true);
    const extended = JSON.parse(
      fs.readFileSync(path.join(hosting, "d", ".brewdocs.json"), "utf8"),
    ) as { draft?: boolean; draftExpires?: string };
    expect(extended.draft).toBe(true);
    expect(extended.draftExpires).toBe(later);
    expect(draftExpired(extended)).toBe(false);

    // Revoke: draft flag + expiry cleared, site stays private.
    expect(setDraftExpiry(hosting, "d", null)).toBe(true);
    const revoked = JSON.parse(
      fs.readFileSync(path.join(hosting, "d", ".brewdocs.json"), "utf8"),
    ) as { draft?: boolean; draftExpires?: string; visibility: string };
    expect(revoked.draft).toBeUndefined();
    expect(revoked.draftExpires).toBeUndefined();
    expect(draftExpired(revoked)).toBe(false);

    // Unknown site -> false, no throw.
    expect(setDraftExpiry(hosting, "missing", null)).toBe(false);
  });
});
