import * as fs from "node:fs";
import * as path from "node:path";

/**
 * v3.0 shared source-tree helpers for the Rust/Java/C#/Ruby adapters. Unlike
 * the v2.x root-only adapters (go, python), these ecosystems keep sources
 * nested under `src/…`; the walker bounds the scan (depth + skip dirs) so
 * vendored trees can never make extraction quadratic. Never throws —
 * unreadable dirs are skipped.
 */

const SKIP_DIRS = new Set([
  "node_modules",
  ".git",
  ".brewdocs",
  ".hg",
  ".svn",
  "dist",
  "target",
  "build",
  "obj",
  "bin",
  "out",
  "vendor",
  ".gradle",
  ".venv",
  "venv",
  "__pycache__",
]);

export function walkSourceFiles(
  root: string,
  exts: string[],
  opts: { maxDepth?: number } = {},
): string[] {
  const maxDepth = opts.maxDepth ?? 8;
  const out: string[] = [];
  const lower = exts.map((e) => e.toLowerCase());

  function visit(dir: string, depth: number): void {
    if (depth > maxDepth) return;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const abs = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (SKIP_DIRS.has(e.name) || e.name.startsWith(".")) continue;
        visit(abs, depth + 1);
      } else if (e.isFile() && lower.some((x) => e.name.toLowerCase().endsWith(x))) {
        out.push(abs);
      }
    }
  }

  visit(path.resolve(root), 0);
  return out.sort();
}

/** Bracket depth (strings not parsed; heuristic by design). */
export function depthOf(cur: string): number {
  let depth = 0;
  for (const ch of cur) {
    if ("([{".includes(ch)) depth++;
    else if (")]}".includes(ch)) depth--;
  }
  return depth;
}

/** True while a physical line obviously continues onto the next one. */
function needsContinuation(cur: string): boolean {
  if (/[{;]$/.test(cur)) return false;
  if (depthOf(cur) > 0) return true;
  return /[({,[]$/.test(cur) || /\)$/.test(cur) || /(?:=>|=[^=])$|=$/.test(cur);
}

/**
 * Fold physical lines starting at `start` into one logical declaration
 * head. Blank lines end a balanced continuation (so the next declaration —
 * or its doc comment — is never swallowed); a lone `{` on the following
 * line is folded in, which is how brace-on-next-line styles parse.
 */
export function readDeclHead(
  lines: string[],
  start: number,
  isTrivia: (trimmed: string) => boolean = () => false,
): { head: string; end: number } {
  let cur = lines[start].trim();
  let i = start;
  while (needsContinuation(cur)) {
    let k = i + 1;
    let sawBlank = false;
    while (k < lines.length) {
      const t = lines[k].trim();
      if (!t) {
        if (depthOf(cur) <= 0) {
          sawBlank = true;
          break;
        }
        k++;
        continue;
      }
      if (isTrivia(t)) {
        k++;
        continue;
      }
      break;
    }
    if (k >= lines.length || sawBlank) break;
    const t = lines[k].trim();
    if (depthOf(cur) <= 0 && !needsContinuation(cur)) break;
    cur = `${cur} ${t}`;
    i = k;
  }
  // brace-on-next-line: fold a lone `{` into the head
  if (!/[{;]$/.test(cur) && depthOf(cur) <= 0) {
    let k = i + 1;
    while (k < lines.length && (!lines[k].trim() || isTrivia(lines[k].trim()))) k++;
    if (k < lines.length && lines[k].trim() === "{") {
      cur = `${cur} {`;
      i = k;
    }
  }
  return { head: cur, end: i };
}
