import { describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { addKey, validateKey, listKeys, revokeKey, loadKeys } from "./keys.js";

function tmp(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "brewdocs-keys-"));
}

describe("Per-user API keys", () => {
  it("issues a key (raw shown once) and validates it", () => {
    const dir = tmp();
    const { key, record } = addKey(dir, { label: "ci" });
    expect(key.startsWith("bd_live_")).toBe(true);
    expect(record.hash).toBeTruthy();
    expect(record.label).toBe("ci");
    // The store keeps only the hash, never the raw key.
    const stored = JSON.parse(fs.readFileSync(path.join(dir, ".keys.json"), "utf8"));
    expect(stored[0].hash).toBe(record.hash);
    expect(JSON.stringify(stored)).not.toContain(key);

    expect(validateKey(dir, key)?.label).toBe("ci");
    expect(validateKey(dir, "wrong")).toBeNull();
  });

  it("supports scopes and listing/revocation", () => {
    const dir = tmp();
    addKey(dir, { scopes: ["build"] });
    expect(listKeys(dir)).toHaveLength(1);
    const { key } = addKey(dir, { scopes: ["export"] });
    expect(listKeys(dir)).toHaveLength(2);
    expect(revokeKey(dir, key)).toBe(true);
    expect(listKeys(dir)).toHaveLength(1);
    // revoke by hash prefix also works
    const remaining = listKeys(dir)[0];
    expect(revokeKey(dir, remaining.hash)).toBe(true);
    expect(loadKeys(dir)).toHaveLength(0);
  });
});
