/**
 * The single HTML escaper. Escapes `& < > " '` so one helper is correct for
 * both text nodes and quoted attributes (`href`, `value`, `title`).
 *
 * A local escaper that forgets a quote is exactly how the attribute-injection
 * XSS shipped (finding #3), so every module imports this one and the gate
 * (`inv-4`) scans *all* source files for a home-grown HTML escaper.
 */
export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/**
 * Drop URLs whose scheme executes in a browser; keep everything else. Control
 * characters are stripped before sniffing because `java\nscript:` is still
 * javascript: to a browser. Returns the trimmed URL, or undefined to omit it.
 */
export function safeUrl(raw: string): string | undefined {
  const trimmed = raw.trim();
  const probe = trimmed.replace(/[\u0000-\u001f\u007f]/g, "").toLowerCase();
  return /^(javascript|vbscript|data):/.test(probe) ? undefined : trimmed;
}
