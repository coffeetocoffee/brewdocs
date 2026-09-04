/**
 * Brew a single cup of docs.
 *
 * @param source - repo or package path to brew from
 * @param strength - how strong the brew is, from 1 (weak) to 5 (bold)
 * @returns the brewed output path
 * @example
 * brew("./repo", 3);
 */
export function brew(source: string, strength: number): string {
  return `${source}:${strength}`;
}

/**
 * Pour an existing brew into a fresh cup.
 *
 * @param input - previously brewed output
 * @param size - cup size in ml
 * @returns a new cup descriptor
 */
export function pour(input: string, size = 250): { input: string; size: number } {
  return { input, size };
}

/**
 * Legacy brew entry point.
 *
 * @deprecated Use {@link brew} instead. It supports strength control.
 */
export function oldBrew(src: string): void {
  brew(src, 2);
}

/** Current released version of the library. */
export const VERSION = "1.2.0";

/** A served cup of documentation. */
export interface Cup {
  /** Volume in millilitres. */
  size: number;
  /** Whether the cup is still hot. */
  hot: boolean;
}
