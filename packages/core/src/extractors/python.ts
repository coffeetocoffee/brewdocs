import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { execFileSync } from "node:child_process";
import type { MemberDoc, ParamDoc, SymbolDoc } from "../types.js";
import type { LanguageAdapter } from "../plugins.js";

/**
 * v2.0 Python extractor: proves the adapter architecture. Runs the stdlib
 * `ast` module over the package (no imports, no execution — static analysis
 * only) and maps its JSON output onto BrewDocs' SymbolDoc contract.
 *
 * Params come from the signature with annotations mapped to TS-ish types so
 * the existing renderer/diff just works: str->string, int/float->number,
 * bool->boolean, None->void, Optional[X]->X | undefined.
 */

const PY_HELPER = String.raw`
import ast, json, os, re, sys

def unparse(node):
    try:
        return ast.unparse(node)
    except Exception:
        return None

def map_type(ann):
    if ann is None:
        return None
    t = unparse(ann)
    if t is None:
        return None
    if t.startswith("Optional[") and t.endswith("]"):
        return map_type_text(t[len("Optional["):-1]) + " | undefined"
    return map_type_text(t)

def map_type_text(t):
    fixed = {
        "str": "string", "unicode": "string", "int": "number", "float": "number",
        "complex": "number", "bool": "boolean", "None": "void", "bytes": "Uint8Array",
        "list": "Array", "dict": "Record", "object": "unknown", "any": "any",
    }
    parts = []
    for piece in t.replace(", ", ",").split("|"):
        piece = piece.strip()
        base = piece.split("[")[0]
        if base in fixed:
            piece = fixed[base] + piece[len(base):]
        parts.append(piece)
    return " | ".join(parts)

def doc_of(node):
    doc = ast.get_docstring(node)
    return doc.strip() if doc else ""

def summary_of(doc):
    if not doc:
        return None
    lines = [l.strip() for l in doc.splitlines()]
    out = []
    for l in lines:
        if l == "":
            break
        out.append(l)
    return " ".join(out) if out else None

def examples_of(doc):
    if not doc:
        return []
    examples = []
    lines = doc.splitlines()
    in_ex = False
    buf = []
    for l in lines:
        stripped = l.strip().lower()
        if stripped.startswith((">>> ", "... ")) or stripped in (
            "example:", "examples:", "usage:", ">>>"):
            in_ex = True
            if stripped.endswith(":"):
                continue
        if in_ex:
            if l.strip() == "" and buf and buf[-1].strip() == "":
                in_ex = False
            buf.append(l)
    text = "\n".join(buf).strip()
    if text:
        examples.append(text)
    return examples

def deprecated_of(node, doc):
    for d in getattr(node, "decorator_list", []) or []:
        name = unparse(d) or ""
        if "deprecated" in name.lower():
            msg = None
            try:
                if isinstance(d, ast.Call) and d.args:
                    msg = unparse(d.args[0]).strip("'\"")
            except Exception:
                pass
            return msg if msg else True
    for line in (doc or "").splitlines():
        low = line.strip().lower()
        if low.startswith(".. deprecated::"):
            rest = line.split("::", 1)[1].strip()
            return rest if rest else True
    return None

def params_of(args, doc_params):
    total = len(args.posonlyargs) + len(args.args)
    defaults = list(args.defaults or [])
    offset = total - len(defaults)
    out = []
    idx = 0
    all_positional = list(args.posonlyargs) + list(args.args)
    for i, a in enumerate(all_positional):
        default = defaults[i - offset] if i >= offset else None
        if a.arg in ("self", "cls") and i == 0:
            continue
        out.append({
            "name": a.arg,
            "type": map_type(a.annotation),
            "optional": default is not None,
            "default": unparse(default) if default is not None else None,
            "description": doc_params.get(a.arg, ""),
        })
    if args.vararg:
        out.append({"name": "*" + args.vararg.arg, "type": map_type(args.vararg.annotation),
                    "optional": False, "default": None, "description": doc_params.get(args.vararg.arg, "")})
    for a, d in zip(args.kwonlyargs, args.kw_defaults or [None] * len(args.kwonlyargs)):
        out.append({"name": a.arg, "type": map_type(a.annotation),
                    "optional": True, "default": unparse(d) if d is not None else None,
                    "description": doc_params.get(a.arg, "")})
    if args.kwarg:
        out.append({"name": "**" + args.kwarg.arg, "type": map_type(args.kwarg.annotation),
                    "optional": False, "default": None, "description": doc_params.get(args.kwarg.arg, "")})
    return out

def parse_doc_params(doc):
    # Google-style "Args:" and Sphinx-style ":param x:" blocks.
    params = {}
    if not doc:
        return params
    mode = None
    for line in doc.splitlines():
        s = line.strip()
        head_word = s.lower().rstrip(":").split(":", 1)[0].strip()
        if head_word in ("args", "arguments", "parameters", "params"):
            mode = "args"
            continue
        if head_word in ("returns", "return", "raises", "yields", "attributes",
                         "example", "examples", "note", "notes", "todo"):
            mode = None
            continue
        if s.startswith(":param"):
            toks = s[len(":param"):].strip().lstrip("*").split()
            if len(toks) >= 2:
                name = toks[0].rstrip(":")
                rest = s.split(":", 3)
                params[name] = rest[3].strip() if len(rest) > 3 else ""
            mode = None
            continue
        if mode == "args" and s and not s.startswith(("-", "*")):
            am = s.split(":", 1)
            name = am[0].strip().split(" ")[0].split("(")[0].lstrip("*")
            if name:
                params[name] = am[1].strip() if len(am) > 1 else ""
                mode = "desc:" + name
            continue
        if isinstance(mode, str) and mode.startswith("desc:"):
            if not s:
                mode = None
                continue
            # A new "name:" / "name (type):" line starts a new parameter.
            if re.match(r"^\*?\*?\w+\s*(\([^)]*\))?\s*:", s):
                am = s.split(":", 1)
                nname = am[0].strip().split(" ")[0].split("(")[0].lstrip("*")
                if nname:
                    params[nname] = am[1].strip() if len(am) > 1 else ""
                    mode = "desc:" + nname
                continue
            name = mode[5:]
            prev = params.get(name, "")
            params[name] = (prev + " " + s).strip() if prev else s
    return params

def signature_of(node):
    src = unparse(node) or ""
    first = src.split("\n")[0]
    return first

def constant_signature(target, value):
    name = unparse(target)
    val = unparse(value)
    return f"{name} = {val}"

def analyze_file(pypath, rel):
    try:
        # utf-8-sig: tolerate a leading BOM some Windows editors add.
        tree = ast.parse(open(pypath, encoding="utf-8-sig").read(), filename=pypath)
    except SyntaxError:
        return None
    syms = []
    for node in tree.body:
        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
            doc = doc_of(node)
            dp = parse_doc_params(doc)
            syms.append({
                "name": node.name,
                "kind": "function",
                "signature": signature_of(node),
                "description": summary_of(doc),
                "params": params_of(node.args, dp),
                "returns": {"type": map_type(node.returns) or "any",
                            "description": ""} if node.returns is not None else None,
                "examples": examples_of(doc),
                "deprecated": deprecated_of(node, doc),
                "sourceFile": rel,
            })
        elif isinstance(node, ast.ClassDef):
            doc = doc_of(node)
            members = []
            for sub in node.body:
                if isinstance(sub, (ast.FunctionDef, ast.AsyncFunctionDef)):
                    sdoc = doc_of(sub)
                    members.append({
                        "name": sub.name, "kind": "method",
                        "signature": signature_of(sub),
                        "description": summary_of(sdoc),
                        "deprecated": deprecated_of(sub, sdoc),
                    })
                elif isinstance(sub, ast.Assign):
                    for t in sub.targets:
                        if isinstance(t, ast.Name):
                            members.append({"name": t.id, "kind": "property",
                                            "signature": None,
                                            "description": None, "type": None})
            syms.append({
                "name": node.name,
                "kind": "class",
                "signature": signature_of(node),
                "description": summary_of(doc),
                "params": [],
                "returns": None,
                "examples": examples_of(doc),
                "deprecated": deprecated_of(node, doc),
                "sourceFile": rel,
                "members": members,
            })
        elif isinstance(node, ast.Assign) and len(node.targets) == 1 and isinstance(node.targets[0], ast.Name):
            syms.append({
                "name": node.targets[0].id,
                "kind": "constant",
                "signature": constant_signature(node.targets[0], node.value),
                "description": None,
                "params": [],
                "returns": None,
                "examples": [],
                "deprecated": None,
                "sourceFile": rel,
            })
        elif isinstance(node, ast.AnnAssign) and isinstance(node.target, ast.Name):
            syms.append({
                "name": node.target.id,
                "kind": "constant",
                "signature": f"{node.target.id}: {map_type(node.annotation)}",
                "description": None,
                "params": [],
                "returns": None,
                "examples": [],
                "deprecated": None,
                "sourceFile": rel,
            })
    return syms

def walk_package(root):
    files = []
    pkg_dir = None
    for entry in sorted(os.listdir(root)):
        cand = os.path.join(root, entry)
        if os.path.isdir(cand) and os.path.exists(os.path.join(cand, "__init__.py")):
            pkg_dir = cand
            break
    if pkg_dir:
        for dirpath, dirnames, filenames in os.walk(pkg_dir):
            dirnames[:] = sorted(d for d in dirnames if d != "__pycache__")
            for fn in sorted(filenames):
                if fn.endswith(".py"):
                    files.append(os.path.join(dirpath, fn))
    else:
        for fn in sorted(os.listdir(root)):
            if fn.endswith(".py") and not fn.startswith("test_"):
                files.append(os.path.join(root, fn))
    return files, (pkg_dir or root)

def main():
    root = sys.argv[1]
    files, base = walk_package(root)
    out = []
    for f in files:
        rel = os.path.relpath(f, root).replace(os.sep, "/")
        if rel.startswith("tests/") or rel.startswith("test"):
            continue
        syms = analyze_file(f, rel)
        if syms:
            out.extend(syms)
    print(json.dumps(out))

main()
`;

interface PySymbol {
  name: string;
  kind: "function" | "class" | "constant";
  signature?: string;
  description?: string | null;
  params?: { name: string; type?: string | null; optional?: boolean; default?: string | null; description?: string | null }[];
  returns?: { type?: string | null; description?: string | null } | null;
  examples?: string[];
  deprecated?: string | boolean | null;
  sourceFile?: string;
  members?: { name: string; kind: "method" | "property"; signature?: string | null; description?: string | null; deprecated?: string | boolean | null }[];
}

function toSymbolDoc(p: PySymbol): SymbolDoc {
  const params: ParamDoc[] = (p.params ?? []).map((x) => ({
    name: x.name,
    type: x.type ?? undefined,
    description: x.description ?? undefined,
    optional: x.optional,
    default: x.default ?? undefined,
  }));
  const members: MemberDoc[] | undefined = p.members?.length
    ? p.members.map((m) => ({
        name: m.name,
        kind: m.kind,
        signature: m.signature ?? undefined,
        description: m.description ?? undefined,
        deprecated: m.deprecated ?? undefined,
      }))
    : undefined;
  return {
    name: p.name,
    kind: p.kind,
    signature: p.signature || undefined,
    description: p.description || undefined,
    params,
    returns: p.returns?.type ? { type: p.returns.type, description: p.returns.description || undefined } : undefined,
    examples: p.examples ?? [],
    deprecated: p.deprecated ?? undefined,
    sourceFile: p.sourceFile,
    members,
  };
}

let cachedPython: string | null | undefined;

/** Locate a usable python; cached, null when absent. */
function findPython(): string | null {
  if (cachedPython !== undefined) return cachedPython;
  for (const bin of process.platform === "win32" ? ["python", "python3"] : ["python3", "python"]) {
    try {
      execFileSync(bin, ["--version"], { stdio: "ignore", timeout: 10_000 });
      cachedPython = bin;
      return bin;
    } catch {
      /* try next */
    }
  }
  cachedPython = null;
  return null;
}

/** Test hook: pretend python appeared/vanished mid-session. */
export function resetPythonProbe(): void {
  cachedPython = undefined;
}

function looksLikePythonPackage(root: string): boolean {
  if (fs.existsSync(path.join(root, "pyproject.toml"))) return true;
  if (fs.existsSync(path.join(root, "setup.py"))) return true;
  try {
    const entries = fs.readdirSync(root, { withFileTypes: true });
    if (entries.some((e) => e.isFile() && e.name.endsWith(".py") && !e.name.startsWith("test_"))) return true;
    if (entries.some((e) => e.isDirectory() && fs.existsSync(path.join(root, e.name, "__init__.py")))) return true;
  } catch {
    /* unreadable dir */
  }
  return false;
}

export const pythonAdapter: LanguageAdapter = {
  id: "python",
  detect(ctx) {
    return looksLikePythonPackage(ctx.root);
  },
  extract(ctx) {
    const py = findPython();
    if (!py) {
      console.warn("[brewdocs] python extractor: no python interpreter found — skipping");
      return [];
    }
    let script: string | undefined;
    try {
      script = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "brewdocs-py-")), "extract.py");
      fs.writeFileSync(script, PY_HELPER, "utf8");
      const out = execFileSync(py, [script, path.resolve(ctx.root)], {
        encoding: "utf8",
        maxBuffer: 32 * 1024 * 1024,
        timeout: 60_000,
        stdio: ["ignore", "pipe", "pipe"],
      });
      const parsed = JSON.parse(out.trim() || "[]") as PySymbol[];
      return parsed.map(toSymbolDoc);
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      console.warn(`[brewdocs] python extractor failed: ${detail}`);
      return [];
    } finally {
      if (script) {
        try {
          fs.rmSync(path.dirname(script), { recursive: true, force: true });
        } catch {
          /* ignore */
        }
      }
    }
  },
};
