import ts from "typescript";
import type { ParamDoc } from "../types.js";

/** Flatten a JSDoc comment (string | NodeArray) into plain text. */
function commentText(comment: string | ts.NodeArray<unknown> | undefined): string {
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
      return node.name?.getText() ?? (typeof node.text === "string" ? node.text : "");
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
}

/** Extract JSDoc/TSDoc info from a declaration node. */
export function parseJsDoc(node: ts.Node): JsDocInfo {
  const info: JsDocInfo = {
    description: "",
    params: [],
    examples: [],
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
      const def = pt.default && "expression" in pt.default
        ? (pt.default as { expression?: { getText(): string } }).expression?.getText()
        : undefined;
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
    } else if (name === "deprecated") {
      const text = commentText(tag.comment);
      info.deprecated = text ? text : true;
    }
  }

  return info;
}
