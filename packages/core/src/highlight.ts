const KEYWORDS = new Set([
  "const", "let", "var", "function", "return", "if", "else", "for", "while",
  "do", "switch", "case", "break", "continue", "class", "extends", "new",
  "import", "export", "from", "default", "interface", "type", "enum",
  "implements", "public", "private", "protected", "readonly", "static",
  "async", "await", "typeof", "instanceof", "in", "of", "as", "void",
  "null", "undefined", "true", "false", "this", "super", "delete", "try",
  "catch", "finally", "throw", "yield", "namespace", "declare", "module",
]);

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

/**
 * Minimal, dependency-free syntax highlighter for JS/TS family code.
 * Returns HTML with <span class="tok-*"> wrappers. Non-matching languages
 * are returned HTML-escaped.
 */
export function highlightCode(code: string, lang: string): string {
  const family = [
    "ts", "tsx", "js", "jsx", "typescript", "javascript",
  ].includes(lang.toLowerCase());

  if (!family) return escapeHtml(code);

  const patterns: Array<[string, RegExp]> = [
    ["comment", /\/\/[^\n]*|\/\*[\s\S]*?\*\//y],
    ["string", /`(?:\\[\s\S]|[^`\\])*`|"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'/y],
    ["number", /\b0x[\da-fA-F]+\b|\b\d+\.?\d*\b/y],
  ];
  const idRe = /[A-Za-z_$][\w$]*/y;

  let out = "";
  let pos = 0;
  const n = code.length;

  while (pos < n) {
    let matched = false;

    for (const [kind, re] of patterns) {
      re.lastIndex = pos;
      const m = re.exec(code);
      if (m && m.index === pos && m[0].length > 0) {
        out += `<span class="tok-${kind}">${escapeHtml(m[0])}</span>`;
        pos += m[0].length;
        matched = true;
        break;
      }
    }
    if (matched) continue;

    idRe.lastIndex = pos;
    const im = idRe.exec(code);
    if (im && im.index === pos) {
      const word = im[0];
      const next = code[im.index + word.length];
      if (KEYWORDS.has(word)) {
        out += `<span class="tok-keyword">${escapeHtml(word)}</span>`;
      } else if (next === "(") {
        out += `<span class="tok-fn">${escapeHtml(word)}</span>`;
      } else {
        out += escapeHtml(word);
      }
      pos += word.length;
      continue;
    }

    out += escapeHtml(code[pos]);
    pos++;
  }

  return out;
}
