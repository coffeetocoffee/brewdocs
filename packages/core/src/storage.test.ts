import { describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  LocalStorageAdapter,
  S3StorageAdapter,
  createStorage,
} from "./deploy/storage.js";

function tmp(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "brewdocs-storage-"));
}

describe("Phase 6 — storage adapters", () => {
  it("LocalStorageAdapter copies the site tree and reports a URL", async () => {
    const base = tmp();
    const site = tmp();
    fs.writeFileSync(path.join(site, "index.html"), "<h1>hi</h1>");
    fs.mkdirSync(path.join(site, "v1"));
    fs.writeFileSync(path.join(site, "v1", "index.html"), "<h1>v1</h1>");

    const adapter = new LocalStorageAdapter({ baseDir: base });
    await adapter.deploy(site, "mysite");
    expect(fs.existsSync(path.join(base, "mysite", "index.html"))).toBe(true);
    expect(fs.existsSync(path.join(base, "mysite", "v1", "index.html"))).toBe(true);
    expect(adapter.urlFor("mysite")).toBe("https://mysite.brewdocs.dev");
  });

  it("createStorage returns a local adapter by default", () => {
    const a = createStorage("local", { local: { baseDir: tmp() } });
    expect(a).toBeInstanceOf(LocalStorageAdapter);
  });

  it("S3 adapter throws a helpful error when the SDK is missing", async () => {
    const adapter = new S3StorageAdapter({
      bucket: "b",
      region: "auto",
      accessKeyId: "x",
      secretAccessKey: "y",
    });
    await expect(adapter.deploy(tmp(), "s")).rejects.toThrow(/@aws-sdk\/client-s3/);
  });
});
