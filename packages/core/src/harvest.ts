import * as fs from "node:fs";
import * as path from "node:path";
import { extractFromSource } from "./extract.js";
import type { SymbolDoc } from "./types.js";

/**
 * v1.0.0 — example harvest. Most packages sit at 0% example coverage because
 * writing examples is tedious — but the usage already exists in the README's
 * fenced code blocks and in the test files. Harvest proposes those real calls
 * as `@example` candidates for symbols that have none, so the author copies
 * instead of writing from scratch.
 */

export interface HarvestProposal {
  symbol: string;
  kind: SymbolDoc["kind"];
  /** The proposed example snippet (a call or a fenced README block). */
  snippet: string;
  /** Where it came from: "README.md" or "<relative file>:<line>". */
  origin: string;
}

const SKIP_DIRS = new Set([
  "node_modules",
  ".git",
  "dist",
  "build",
  "out",
  "coverage",
  ".brewdocs",
]);

const TEST_FILE = /\.(test|spec)\.[cm]?[jt]sx?$/;
const README_FILES = ["README.md", "readme.md", "Readme.md"];
const MAX_FILES = 200;

/** Fenced code blocks of a markdown file with their 1-based start line. */
function readmeBlocks(text: string): Array<{ code: string; line: number }> {
  const lines = text.split(/\r?\n/);
  const blocks: Array<{ code: string; line: number }> = [];
  let i = 0;
  while (i < lines.length) {
    if (/^\s*```/.test(lines[i])) {
      const start = i + 1; // 1-based line of the opening fence
      i++;
      const body: string[] = [];
      while (i < lines.length && !/^\s*```/.test(lines[i])) {
        body.push(lines[i]);
        i++;
      }
      blocks.push({ code: body.join("\n").trim(), line: start });
    }
    i++;
  }
  return blocks;
}

/** Expand `name(` to the full balanced call expression. */
function extractCall(text: string, openParen: number): string | undefined {
  let depth = 0;
  const end = Math.min(text.length, openParen + 2000);
  for (let i = openParen; i < end; i++) {
    if (text[i] === "(") depth++;
    else if (text[i] === ")") {
      depth--;
      if (depth === 0) return text.slice(openParen, i + 1);
    }
  }
  return undefined;
}

/** Candidate snippets for one symbol within a code/test file. */
function callsInCode(
  code: string,
  symbol: string,
  fileLabel: string,
): HarvestProposal | undefined {
  const re = new RegExp(`(?<![\\w$])${symbol.replace(/\$/g, "\\$")}\\s*\\(`);
  const m = re.exec(code);
  if (!m) return undefined;
  const call = extractCall(code, code.indexOf("(", m.index));
  if (!call) return undefined;
  const line = code.slice(0, m.index).split("\n").length;
  return {
    symbol,
    kind: "unknown",
    snippet: `${symbol}${call};`,
    origin: `${fileLabel}:${line}`,
  };
}

/** Walk the source root for test files (bounded). */
function testFiles(root: string): string[] {
  const out: string[] = [];
  const walk = (dir: string, depth: number): void => {
    if (out.length >= MAX_FILES || depth > 4) return;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (out.length >= MAX_FILES) return;
      const abs = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (!SKIP_DIRS.has(e.name) && !e.name.startsWith(".")) walk(abs, depth + 1);
      } else if (e.isFile() && TEST_FILE.test(e.name)) {
        out.push(abs);
      }
    }
  };
  walk(root, 0);
  return out;
}

/**
 * Propose example snippets for every exported symbol that has no `@example`.
 * Sources: fenced blocks in the README and calls in test files. One proposal
 * per symbol (first hit wins). Pure analysis — never writes files.
 */
export function harvestExamples(source: { root: string; name?: string }): HarvestProposal[] {
  const extracted = extractFromSource(source);
  const targets = extracted.symbols.filter((s) => s.examples.length === 0);
  if (targets.length === 0) return [];
  const byName = new Map(targets.map((s) => [s.name, s]));
  const proposals: HarvestProposal[] = [];
  const found = new Set<string>();

  const rootPath = path.resolve(source.root);
  const label = (abs: string): string =>
    path.relative(rootPath, abs).replace(/\\/g, "/") || path.basename(abs);

  // 1) README fenced blocks — richest snippets first.
  for (const name of README_FILES) {
    const readmePath = path.join(rootPath, name);
    if (!fs.existsSync(readmePath)) continue;
    let text: string;
    try {
      text = fs.readFileSync(readmePath, "utf8");
    } catch {
      continue;
    }
    for (const block of readmeBlocks(text)) {
      if (block.code.length === 0 || block.code.length > 1200) continue;
      for (const sym of targets) {
        if (found.has(sym.name)) continue;
        if (new RegExp(`(?<![\\w$])${sym.name.replace(/\$/g, "\\$")}\\b`).test(block.code)) {
          proposals.push({
            symbol: sym.name,
            kind: sym.kind,
            snippet: block.code,
            origin: `${name}:${block.line}`,
          });
          found.add(sym.name);
        }
      }
    }
  }

  // 2) Test files — direct calls become one-line examples.
  for (const file of testFiles(rootPath)) {
    let code: string;
    try {
      code = fs.readFileSync(file, "utf8");
    } catch {
      continue;
    }
    for (const sym of targets) {
      if (found.has(sym.name)) continue;
      const p = callsInCode(code, sym.name, label(file));
      if (p) {
        proposals.push({ ...p, symbol: sym.name, kind: sym.kind });
        found.add(sym.name);
      }
    }
  }

  return proposals;
}
