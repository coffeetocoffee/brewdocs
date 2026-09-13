import {
  BUILTIN_PLUGINS,
  type AdapterContext,
  type BrewDocsPlugin,
  type LanguageAdapter,
  type ThemeContribution,
  type ThemeSlotPartials,
} from "@brewdocs/core";

/**
 * @brewdocs/plugin-sdk — the contract surface for third-party BrewDocs
 * plugins. Depends on @brewdocs/core only for types; ship plain objects.
 *
 * A plugin can:
 *   1. register language adapters (symbol extractors for new ecosystems),
 *   2. hook the pipeline (`onExtract` after extraction, `onRender` per page),
 *   3. contribute theme vars and layout-slot partials.
 *
 * @example
 * import { definePlugin } from "@brewdocs/plugin-sdk";
 *
 * export default definePlugin({
 *   name: "brewdocs-timestamp",
 *   onRender(html) {
 *     return html.replace("</footer>", ` <span>· stamped</span></footer>`);
 *   },
 * });
 */

export function definePlugin(plugin: BrewDocsPlugin): BrewDocsPlugin {
  if (!plugin || typeof plugin !== "object") {
    throw new Error("definePlugin expects a plugin object with at least a name");
  }
  if (!plugin.name) {
    throw new Error("definePlugin requires a plugin `name`");
  }
  return plugin;
}

export function defineAdapter(adapter: LanguageAdapter): LanguageAdapter {
  if (!adapter.id || typeof adapter.detect !== "function" || typeof adapter.extract !== "function") {
    throw new Error("defineAdapter requires { id, detect(ctx), extract(ctx) }");
  }
  return adapter;
}

/** The built-in adapters (python, go) — reuse or shadow them in plugins. */
export { BUILTIN_PLUGINS };

export type {
  AdapterContext,
  BrewDocsPlugin,
  LanguageAdapter,
  ThemeContribution,
  ThemeSlotPartials,
};
