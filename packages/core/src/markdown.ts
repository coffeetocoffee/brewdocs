import { highlightCode } from "./highlight.js";
import { escapeHtml, safeUrl } from "./escape.js";

function inline(text: string): string {
  let s = escapeHtml(text);
  // The URL captured here is post-escape, so its own `&`/`"` are already
  // entities; validate the scheme and drop the link when it is unsafe.
  s = s.replace(/!\[([^\]]*)\]\(([^)\s]+)\)/g, (_m, alt, url) => {
    const safe = safeUrl(url);
    return safe === undefined ? "" : `<img src="${safe}" alt="${alt}" />`;
  });
  s = s.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_m, t, url) => {
    const safe = safeUrl(url);
    return safe === undefined ? t : `<a href="${safe}">${t}</a>`;
  });
  s = s.replace(/`([^`]+)`/g, (_m, c) => `<code>${c}</code>`);
  s = s.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  s = s.replace(/__([^_]+)__/g, "<strong>$1</strong>");
  s = s.replace(/(^|[^*])\*([^*\n]+)\*/g, "$1<em>$2</em>");
  s = s.replace(/(^|[^_])_([^_\n]+)_/g, "$1<em>$2</em>");
  s = s.replace(/~~([^~]+)~~/g, "<del>$1</del>");
  return s;
}

function parseRow(line: string): string[] {
  return line
    .replace(/^\s*\|/, "")
    .replace(/\|?\s*$/, "")
    .split("|")
    .map((c) => c.trim());
}

/**
 * Render a subset of CommonMark to HTML (headings, code, lists, tables, quotes, inline).
 *
 * @param md - Markdown source to render.
 * @returns the rendered HTML.
 */
export function markdownToHtml(md: string): string {
  const lines = md.replace(/\r\n/g, "\n").split("\n");
  const out: string[] = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];

    // CommonMark allows whitespace between the fence and the info string
    // (e.g. "``` ts") — without it this line would match no branch and the
    // paragraph loop below would spin forever without advancing.
    const fence = /^```[ \t]*(\w*)/.exec(line);
    if (fence) {
      const lang = fence[1] || "";
      const buf: string[] = [];
      i++;
      while (i < lines.length && !/^```\s*$/.test(lines[i])) {
        buf.push(lines[i]);
        i++;
      }
      i++;
      const code = buf.join("\n");
      out.push(
        `<pre class="code" data-lang="${escapeHtml(lang)}"><code>${highlightCode(
          code,
          lang,
        )}</code></pre>`,
      );
      continue;
    }

    if (line.trim() === "") {
      i++;
      continue;
    }

    const heading = /^(#{1,6})\s+(.*)$/.exec(line);
    if (heading) {
      const lvl = heading[1].length;
      out.push(`<h${lvl}>${inline(heading[2].trim())}</h${lvl}>`);
      i++;
      continue;
    }

    if (/^\s*([-*_])\1{2,}\s*$/.test(line)) {
      out.push("<hr />");
      i++;
      continue;
    }

    if (/^>\s?/.test(line)) {
      const buf: string[] = [];
      while (i < lines.length && /^>\s?/.test(lines[i])) {
        buf.push(lines[i].replace(/^>\s?/, ""));
        i++;
      }
      out.push(`<blockquote>${markdownToHtml(buf.join("\n"))}</blockquote>`);
      continue;
    }

    if (
      line.includes("|") &&
      i + 1 < lines.length &&
      /^\s*\|?[\s:|-]*-[\s:|-]*\|?\s*$/.test(lines[i + 1])
    ) {
      const header = parseRow(line);
      i += 2;
      const rows: string[][] = [];
      while (i < lines.length && lines[i].includes("|") && lines[i].trim() !== "") {
        rows.push(parseRow(lines[i]));
        i++;
      }
      const thead = `<thead><tr>${header
        .map((h) => `<th>${inline(h)}</th>`)
        .join("")}</tr></thead>`;
      const tbody = `<tbody>${rows
        .map((r) => `<tr>${r.map((c) => `<td>${inline(c)}</td>`).join("")}</tr>`)
        .join("")}</tbody>`;
      out.push(`<table>${thead}${tbody}</table>`);
      continue;
    }

    if (/^\s*([-*+]|[0-9]+\.)\s+/.test(line)) {
      const ordered = /^\s*[0-9]+\.\s+/.test(line);
      const items: string[] = [];
      while (i < lines.length && /^\s*([-*+]|[0-9]+\.)\s+/.test(lines[i])) {
        const m = /^\s*([-*+]|[0-9]+\.)\s+(.*)$/.exec(lines[i]);
        if (m) items.push(`<li>${inline(m[2])}</li>`);
        i++;
      }
      const tag = ordered ? "ol" : "ul";
      out.push(`<${tag}>${items.join("")}</${tag}>`);
      continue;
    }

    const para: string[] = [];
    while (
      i < lines.length &&
      lines[i].trim() !== "" &&
      !/^```/.test(lines[i]) &&
      !/^#{1,6}\s/.test(lines[i]) &&
      !/^>\s?/.test(lines[i]) &&
      !/^\s*([-*+]|[0-9]+\.)\s+/.test(lines[i]) &&
      !/^\s*([-*_])\1{2,}\s*$/.test(lines[i])
    ) {
      para.push(lines[i]);
      i++;
    }
    // Safety net: if nothing was consumed (the line matched a stop pattern
    // but no branch above handled it), emit it verbatim and advance so the
    // outer loop can never spin without progress.
    if (para.length === 0) {
      out.push(`<p>${inline(line)}</p>`);
      i++;
      continue;
    }
    out.push(`<p>${inline(para.join(" "))}</p>`);
  }

  return out.join("\n");
}
