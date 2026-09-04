import ts from "typescript";
import type { ParamDoc } from "../types.js";

/**
 * Read an {@link ...}/`@see` link target. Link name nodes are detached from
 * the AST parent chain, so `getText()` can throw or return "" — fall back to
 * the raw identifier text (identifiers use `escapedText`, member chains use
 * left/right).
 */
function linkTargetName(name: unknown): string {
  if (!name || typeof name !== "object") return "";
  const n = name as {
    getText?: () => string;
    escapedText?: unknown;
    left?: unknown;
    right?: unknown;
  };
  try {
    const t = n.getText?.();
    if (t) return t;
  } catch {
    /* fall through */
  }
  if (typeof n.escapedText === "string") return n.escapedText;
  if (n.left && n.right) return `${linkTargetName(n.left)}.${linkTargetName(n.right)}`;
  return "";
}

/** Flatten a JSDoc comment (string | NodeArray) into plain text. */
function commentText(comment: string | ts.NodeArray<ts.Node> | undefined): string {
  if (!comment) return "";
  if (typeof comment === "string") return comment.trim();
  const part = (n: unknown): string => {
    const node = n as {
      kind?: ts.SyntaxKind;
      text?: string;
      name?: { getText(): string };
      getText?: () => string;
    };
    if (
      node.kind === ts.SyntaxKind.JSDocLink ||
      node.kind === ts.SyntaxKind.JSDocLinkCode ||
      node.kind === ts.SyntaxKind.JSDocLinkPlain
    ) {
      return `${linkTargetName(node.name)}${typeof node.text === "string" ? node.text : ""}`;
    }
    if (typeof node.text === "string") return node.text;
    if (typeof node.getText === "function") {
      try {
        return node.getText();
      } catch {
        return "";
      }
    }
    return "";
  };
  return comment.map(part).join("").trim();
}

export interface JsDocInfo {
  description: string;
  params: ParamDoc[];
  returns?: { type?: string; description?: string };
  examples: string[];
  deprecated?: string | boolean;
  throws: string[];
  see: string[];
}

/** Extract JSDoc/TSDoc info from a declaration node. */
export function parseJsDoc(node: ts.Node): JsDocInfo {
  const info: JsDocInfo = {
    description: "",
    params: [],
    examples: [],
    throws: [],
    see: [],
  };

  const jsDoc = (node as unknown as { jsDoc?: ts.JSDoc[] }).jsDoc;
  if (jsDoc && jsDoc.length) {
    const doc = jsDoc[0];
    info.description = commentText(doc.comment);
  }

  const tags = ts.getJSDocTags(node);

  for (const tag of tags) {
    const name = tag.tagName.text;
    if (name === "param") {
      const pt = tag as ts.JSDocParameterTag;
      const paramName = pt.name ? pt.name.getText() : "";
      const type = pt.typeExpression?.type.getText();
      const optional = Boolean(pt.isBracketed);
      const defNode = (pt as unknown as { default?: { expression?: { getText(): string } } })
        .default;
      const def = defNode?.expression?.getText();
      const rawDesc = commentText(tag.comment).replace(/^-\s*/, "");
      info.params.push({
        name: paramName,
        type: type,
        description: rawDesc,
        optional: optional,
        default: def,
      });
    } else if (name === "returns" || name === "return") {
      const rt = tag as ts.JSDocReturnTag;
      info.returns = {
        type: rt.typeExpression?.type.getText(),
        description: commentText(rt.comment),
      };
    } else if (name === "example") {
      info.examples.push(commentText(tag.comment));
    } else if (name === "throws" || name === "throw") {
      const text = commentText(tag.comment).trim();
      const type = (tag as ts.JSDocTypeTag).typeExpression?.type.getText();
      info.throws.push(type ? `${type} ${text}`.trim() : text || "unknown error");
    } else if (name === "see") {
      // `@see Vault for full lifecycle control` — TS puts the link target on
      // the tag's `name` (an EntityName node detached from the parent chain)
      // and only the trailing text lands in `comment`.
      const target = linkTargetName((tag as unknown as { name?: unknown }).name);
      const text = commentText(tag.comment).trim();
      const full = [target, text].filter(Boolean).join(" ").trim();
      if (full) info.see.push(full);
    } else if (name === "deprecated") {
      const text = commentText(tag.comment);
      info.deprecated = text ? text : true;
    }
  }

  return info;
}
