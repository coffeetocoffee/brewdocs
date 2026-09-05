import * as childProcess from "node:child_process";
import { findGitRoot } from "./build.js";

/**
 * Short-lived helper for the Direction C freshness stamp: the current HEAD
 * sha of the source repo, or undefined outside git / on failure.
 */
export function gitShaOf(root: string): string | undefined {
  const gitRoot = findGitRoot(root);
  if (!gitRoot) return undefined;
  try {
    const sha = childProcess
      .execFileSync("git", ["rev-parse", "HEAD"], {
        cwd: gitRoot,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      })
      .trim();
    return sha || undefined;
  } catch {
    return undefined;
  }
}
