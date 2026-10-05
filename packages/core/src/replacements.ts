import type { SymbolDoc } from "./types.js";

/**
 * Deprecation → replacement graph (Direction C). A `@deprecated` symbol
 * usually points at its successor somewhere in the same comment — a bare
 * `@see NewThing`, an inline `{@link NewThing}`, or prose like
 * "use newThing instead". Resolve those against the exported symbol set so
 * downstream surfaces can say "use X instead" instead of just "deprecated".
 */

const IDENT_RE = /[A-Za-z_$][A-Za-z0-9_$]*/g;

/** Candidates worth matching: identifiers of reasonable length, no keywords. */
const NOT_IDENTIFIERS = new Set([
  "use",
  "instead",
  "see",
  "the",
  "a",
  "an",
  "of",
  "in",
  "and",
  "or",
  "this",
  "that",
  "with",
  "from",
  "by",
  "is",
  "was",
  "be",
  "been",
  "it",
  "its",
  "as",
  "to",
  "on",
  "for",
  "replaced",
  "replacement",
  "prefer",
  "recommended",
  "new",
  "old",
  "please",
  "note",
]);

/**
 * Pure: map each deprecated symbol to the exported symbols it points at.
 * Only names that exist in the exported set count as successors — prose
 * references to internal types or plain English are ignored.
 *
 * @param symbols - extracted symbols to scan for deprecation references.
 * @returns deprecated symbol name to successor symbol names map.
 */
export function resolveReplacements(symbols: SymbolDoc[]): Record<string, string[]> {
  const names = new Set(symbols.map((s) => s.name));
  const out: Record<string, string[]> = {};

  for (const sym of symbols) {
    if (!sym.deprecated) continue;
    const candidates = new Set<string>();

    for (const text of candidateTexts(sym)) {
      for (const m of text.matchAll(IDENT_RE)) {
        const word = m[0];
        if (word === sym.name) continue;
        if (NOT_IDENTIFIERS.has(word.toLowerCase())) continue;
        if (names.has(word)) candidates.add(word);
      }
    }

    if (candidates.size > 0) out[sym.name] = [...candidates];
  }
  return out;
}

function candidateTexts(sym: SymbolDoc): string[] {
  const texts: string[] = [...(sym.see ?? [])];
  if (typeof sym.deprecated === "string") texts.push(sym.deprecated);
  return texts;
}

/**
 * `use \`X\` instead` when a successor is known, "" otherwise.
 *
 * @param replacements - successor symbol names, or undefined when unknown.
 * @returns the hint phrase, or an empty string when there is nothing to suggest.
 */
export function replacementHint(replacements: string[] | undefined): string {
  if (!replacements || replacements.length === 0) return "";
  return `use \`${replacements.join("` or `")}\` instead`;
}
