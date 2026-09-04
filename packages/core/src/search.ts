import type { RenderModel } from "./types.js";

export interface SearchDoc {
  id: string;
  title: string;
  kind: string;
  url: string;
  body: string;
}

function stripHtml(html: string): string {
  return html
    .replace(/<[^>]+>/g, " ")
    .replace(/&[a-z]+;/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Build a serializable search index from a render model. Covers README
 * sections and exported symbols. Designed to be embedded in the page and
 * queried client-side with no external dependency.
 */
export function buildSearchIndex(model: RenderModel): SearchDoc[] {
  const docs: SearchDoc[] = [];

  for (const section of model.sections) {
    docs.push({
      id: section.id,
      title: section.title,
      kind: "section",
      url: `#${section.id}`,
      body: stripHtml(section.html),
    });
  }

  for (const sym of model.symbols) {
    const body = [
      sym.description ?? "",
      sym.signature ?? "",
      sym.params.map((p) => `${p.name} ${p.description ?? ""}`).join(" "),
      sym.returns?.description ?? "",
    ]
      .join(" ")
      .trim();
    docs.push({
      id: `symbol-${sym.name}`,
      title: sym.name,
      kind: sym.kind,
      url: `#symbol-${sym.name}`,
      body,
    });
  }

  return docs;
}
