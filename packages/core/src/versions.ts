import { execFile } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/** Walk up from `start` to locate the enclosing git repo root, if any. */
function findGitRoot(start: string): string | null {
  let dir = path.resolve(start);
  for (;;) {
    if (fs.existsSync(path.join(dir, ".git"))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

export function readPackageVersion(root: string): string {
  try {
    const pkg = JSON.parse(
      fs.readFileSync(path.join(root, "package.json"), "utf8"),
    );
    if (typeof pkg.version === "string") return pkg.version;
  } catch {
    /* ignore */
  }
  return "dev";
}

/**
 * Discover available doc versions for a source.
 *
 * If the directory lives inside a git repo (including monorepo
 * subdirectories), returns the repo's tags plus a "dev" entry for the
 * working tree. Otherwise it returns just the current package version. The
 * function never throws — without git it gracefully degrades.
 */
export async function discoverVersions(root: string): Promise<string[]> {
  const pkgVersion = readPackageVersion(root);
  const gitRoot = findGitRoot(root);

  if (!gitRoot) {
    return [pkgVersion];
  }

  try {
    const { stdout } = await execFileAsync(
      "git",
      ["tag", "--list", "--sort=-v:refname"],
      { cwd: gitRoot },
    );
    const tags = stdout
      .split(/\r?\n/)
      .map((t) => t.trim())
      .filter(Boolean);
    if (tags.length === 0) return [pkgVersion];
    // Put the package version first if it matches a tag, else prepend it.
    const ordered = tags.includes(pkgVersion)
      ? tags
      : [pkgVersion, ...tags];
    return ordered;
  } catch {
    return [pkgVersion];
  }
}
