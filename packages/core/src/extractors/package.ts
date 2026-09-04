import type { PackageInfo } from "../types.js";

/** Coerce a parsed package.json into the structured PackageInfo shape. */
export function extractPackage(pkg: Record<string, unknown>): PackageInfo {
  const str = (v: unknown): string | undefined =>
    typeof v === "string" ? v : undefined;

  const keywords = Array.isArray(pkg.keywords)
    ? pkg.keywords.filter((k): k is string => typeof k === "string")
    : undefined;

  const deps = (v: unknown): Record<string, string> | undefined => {
    if (v && typeof v === "object") {
      const out: Record<string, string> = {};
      for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
        if (typeof val === "string") out[k] = val;
      }
      return out;
    }
    return undefined;
  };

  return {
    name: str(pkg.name),
    version: str(pkg.version),
    description: str(pkg.description),
    license: str(pkg.license),
    homepage: str(pkg.homepage),
    repository: str(pkg.repository),
    keywords,
    bin: (pkg.bin as PackageInfo["bin"]) ?? undefined,
    exports: pkg.exports,
    dependencies: deps(pkg.dependencies),
    devDependencies: deps(pkg.devDependencies),
    scripts: (pkg.scripts as Record<string, string>) ?? undefined,
  };
}
