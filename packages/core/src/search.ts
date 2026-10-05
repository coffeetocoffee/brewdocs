import type { RenderModel } from "./types.js";

/** One client-search document: title, kind, href and searchable text. */
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
 *
 * @param model - render model whose sections and symbols are indexed.
 * @param multiPage - when true, symbol URLs point at per-symbol pages instead of anchors.
 * @returns the serializable search documents.
 */
export function buildSearchIndex(model: RenderModel, multiPage = false): SearchDoc[] {
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

  const slug = (name: string) =>
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "");

  for (const sym of model.symbols) {
    const body = [
      sym.description ?? "",
      sym.signature ?? "",
      sym.params.map((p) => `${p.name} ${p.description ?? ""}`).join(" "),
      sym.returns?.description ?? "",
      (sym.members ?? []).map((m) => `${m.name} ${m.description ?? ""}`).join(" "),
      (sym.throws ?? []).join(" "),
      (sym.see ?? []).join(" "),
    ]
      .join(" ")
      .trim();
    docs.push({
      id: `symbol-${sym.name}`,
      title: sym.name,
      kind: sym.kind,
      url: multiPage ? `symbols/${slug(sym.name)}.html` : `#symbol-${sym.name}`,
      body,
    });
  }

  return docs;
}
