import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { Source } from "./types.js";

export interface ResolvedSource {
  source: Source;
  /** Remove any temp dirs created during resolution. */
  cleanup: () => void;
}

const NPM_NAME = /^(@[a-z0-9-~][a-z0-9-._~]*\/)?[a-z0-9-~][a-z0-9-._~]*$/i;
const GITHUB_URL = /github\.com[/:]([^/]+)\/([^/#?.\s]+)/i;

/**
 * Turn a user input (local path, npm package, or GitHub URL) into a local
 * source directory. Network steps (npm install / git clone) are best-effort
 * and throw a clear error when unavailable, so the web UI can surface it.
 */
export function resolveInput(input: string): ResolvedSource {
  const raw = input.trim();
  if (!raw) throw new Error("Empty input");

  // 1) Local path
  if (fs.existsSync(raw)) {
    return { source: { root: path.resolve(raw) }, cleanup: () => {} };
  }

  // 2) npm package
  const isNpmUrl = /^https?:\/\/(www\.)?npmjs\.com\/package\//i.test(raw);
  if (isNpmUrl || NPM_NAME.test(raw)) {
    const name = isNpmUrl ? raw.replace(/^.*\/package\//i, "") : raw;
    return installNpm(name);
  }

  // 3) GitHub URL
  const gh = GITHUB_URL.exec(raw);
  if (gh) {
    return cloneGit(`https://github.com/${gh[1]}/${gh[2]}.git`);
  }

  throw new Error(
    `Cannot resolve "${raw}". Provide a local path, an npm package name, or a GitHub URL.`,
  );
}

/**
 * Run the npm CLI cross-platform. On Windows npm is `npm.cmd`, and spawning
 * `.cmd` files requires `shell: true` (with manual quoting) on patched Node
 * versions; plain `execFileSync("npm")` throws ENOENT there.
 */
export function runNpm(args: string[], opts: { capture?: boolean } = {}): string {
  const win = process.platform === "win32";
  const out = execFileSync(win ? "npm.cmd" : "npm", win ? args.map((a) => `"${a}"`) : args, {
    stdio: opts.capture ? ["ignore", "pipe", "ignore"] : "ignore",
    shell: win,
    encoding: "utf8",
  });
  return out ?? "";
}

function installNpm(name: string): ResolvedSource {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "brewdocs-npm-"));
  try {
    runNpm(["install", name, "--no-save", "--prefix", tmp]);
  } catch {
    fs.rmSync(tmp, { recursive: true, force: true });
    throw new Error(
      `Failed to fetch npm package "${name}" (need network + npm).`,
    );
  }
  const root = path.join(tmp, "node_modules", name);
  if (!fs.existsSync(root)) {
    fs.rmSync(tmp, { recursive: true, force: true });
    throw new Error(`npm package "${name}" installed but entry not found.`);
  }
  return {
    source: { root, name },
    cleanup: () => fs.rmSync(tmp, { recursive: true, force: true }),
  };
}

function cloneGit(url: string): ResolvedSource {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "brewdocs-gh-"));
  try {
    execFileSync("git", ["clone", "--depth", "1", url, tmp], {
      stdio: "ignore",
    });
  } catch {
    fs.rmSync(tmp, { recursive: true, force: true });
    throw new Error(`Failed to clone "${url}" (need network + git).`);
  }
  return {
    source: { root: tmp, name: url },
    cleanup: () => fs.rmSync(tmp, { recursive: true, force: true }),
  };
}
