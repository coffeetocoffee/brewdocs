import { markdownToHtml } from "../markdown.js";
import type { Frontmatter, ReadmeResult, SectionDoc } from "../types.js";

function slug(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/** Parse simple `key: value` frontmatter (no nested YAML). */
function parseFrontmatter(
  body: string,
): { data: Frontmatter; rest: string } {
  const data: Frontmatter = {};
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(body);
  if (!match) return { data, rest: body };

  for (const line of match[1].split(/\r?\n/)) {
    const m = /^([A-Za-z0-9_-]+)\s*:\s*(.*)$/.exec(line);
    if (m) data[m[1].toLowerCase()] = m[2].trim();
  }
  return { data, rest: body.slice(match[0].length) };
}

/** Convert a README into frontmatter + heading-delimited sections. */
export function extractReadme(markdown: string): ReadmeResult {
  const { data, rest } = parseFrontmatter(markdown);
  const lines = rest.replace(/\r\n/g, "\n").split("\n");

  const sections: SectionDoc[] = [];
  let current: SectionDoc | null = null;
  let buf: string[] = [];

  const flush = () => {
    if (current) {
      current.html = markdownToHtml(buf.join("\n")).trim();
      sections.push(current);
    }
    buf = [];
  };

  for (const line of lines) {
    const heading = /^(#{1,6})\s+(.*)$/.exec(line);
    if (heading && current === null) {
      // First heading becomes the leading section (title area).
      current = {
        id: slug(heading[2]),
        title: heading[2].trim(),
        level: heading[1].length,
        html: "",
      };
      continue;
    }
    if (heading && current) {
      flush();
      current = {
        id: slug(heading[2]),
        title: heading[2].trim(),
        level: heading[1].length,
        html: "",
      };
      continue;
    }
    buf.push(line);
  }
  flush();

  return { frontmatter: data, sections, html: markdownToHtml(rest).trim() };
}
