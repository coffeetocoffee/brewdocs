/**
 * The single HTML escaper. Escapes `& < > " '` so one helper is correct for
 * both text nodes and quoted attributes (`href`, `value`, `title`).
 *
 * A local escaper that forgets a quote is exactly how the attribute-injection
 * XSS shipped (finding #3), so every module imports this one and the gate
 * (`inv-4`) scans *all* source files for a home-grown HTML escaper.
 *
 * @param s - raw text to escape for HTML text/attribute contexts.
 * @returns the text with `& < > " '` replaced by entities.
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
 *
 * @param raw - URL string to validate.
 * @returns the trimmed URL, or undefined when it uses an executable scheme.
 */
export function safeUrl(raw: string): string | undefined {
  const trimmed = raw.trim();
  const probe = trimmed.replace(/[\u0000-\u001f\u007f]/g, "").toLowerCase();
  return /^(javascript|vbscript|data):/.test(probe) ? undefined : trimmed;
}

/**
 * Neutralize JSON for safe interpolation inside an HTML `<script>` block.
 *
 * In WHATWG HTML tokenizer rules, inside a `<script>` element, `<!--` triggers
 * the "script data escaped" state and `<script` enters the "script data double
 * escaped" state where `</script>` does NOT close the element. Escaping every
 * `<` as `\u003c` prevents the HTML parser from seeing comments, open tags,
 * or end tags. When client code calls `JSON.parse()`, `\u003c` decodes back to
 * `<` transparently with no semantic loss.
 *
 * @param json - serialized JSON string to embed inside a script tag.
 * @returns the JSON string with every `<` replaced with `\u003c`.
 */
export function escapeScriptJson(json: string): string {
  return json.replace(/</g, "\\u003c");
}
