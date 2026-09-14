/**
 * v3.0 UI localization. Only the *chrome* is translated (labels, headings,
 * banners, empty states) — doc content stays whatever the author wrote.
 * Dictionaries are partial: every missing key falls back to English, so a
 * new locale can ship a handful of strings and improve over time.
 *
 * Locale lives in `brewdocs.yml` (`locale: id`) or `--locale <code>` and
 * sets `<html lang>` + every UI string at render time.
 */

export interface UiStrings {
  api: string;
  parameters: string;
  returns: string;
  members: string;
  throws: string;
  see: string;
  example: string;
  version: string;
  searchPlaceholder: string;
  searchDocs: string;
  noResults: string;
  skipToContent: string;
  toggleTheme: string;
  tableOfContents: string;
  onThisPage: string;
  guides: string;
  backToDocs: string;
  emptyTitle: string;
  emptyBody: string;
  deprecated: string;
  documented: string;
  coverageTitle: string;
  eolBadge: string;
  eolBanner: string;
  brewedWith: string;
  tagline: string;
}

const EN: UiStrings = {
  api: "API",
  parameters: "Parameters",
  returns: "Returns",
  members: "Members",
  throws: "Throws",
  see: "See",
  example: "Example",
  version: "Version:",
  searchPlaceholder: "Search docs…  (⌘K / Ctrl+K)",
  searchDocs: "Search docs",
  noResults: "No results",
  skipToContent: "Skip to content",
  toggleTheme: "Toggle theme",
  tableOfContents: "Table of contents",
  onThisPage: "On this page",
  guides: "Guides",
  backToDocs: "Back to docs",
  emptyTitle: "Nothing brewed yet",
  emptyBody:
    "This package has no README or exported symbols BrewDocs could find. Add a <code>README.md</code> or exported functions to see docs here.",
  deprecated: "deprecated",
  documented: "documented",
  coverageTitle: "Docs coverage from brewdocs doctor",
  eolBadge: "EOL",
  eolBanner: "This version is no longer maintained.",
  brewedWith: "Brewed with",
  tagline: "Brew your docs, serve them hot.",
};

const DE: Partial<UiStrings> = {
  parameters: "Parameter",
  returns: "Rückgabe",
  members: "Mitglieder",
  throws: "Wirft",
  see: "Siehe",
  example: "Beispiel",
  version: "Version:",
  searchPlaceholder: "Doku durchsuchen…  (⌘K / Strg+K)",
  searchDocs: "Doku durchsuchen",
  noResults: "Keine Treffer",
  skipToContent: "Zum Inhalt springen",
  toggleTheme: "Design wechseln",
  tableOfContents: "Inhaltsverzeichnis",
  onThisPage: "Auf dieser Seite",
  guides: "Anleitungen",
  backToDocs: "Zurück zur Doku",
  emptyTitle: "Noch nichts gebrüht",
  deprecated: "veraltet",
  documented: "dokumentiert",
  eolBanner: "Diese Version wird nicht mehr gepflegt.",
  brewedWith: "Gebrüht mit",
  tagline: "Brew your docs, serve them hot.",
};

const ES: Partial<UiStrings> = {
  parameters: "Parámetros",
  returns: "Devuelve",
  members: "Miembros",
  throws: "Lanza",
  see: "Véase",
  example: "Ejemplo",
  version: "Versión:",
  searchPlaceholder: "Buscar…  (⌘K / Ctrl+K)",
  searchDocs: "Buscar documentación",
  noResults: "Sin resultados",
  skipToContent: "Saltar al contenido",
  toggleTheme: "Cambiar tema",
  tableOfContents: "Índice",
  onThisPage: "En esta página",
  guides: "Guías",
  backToDocs: "Volver a la documentación",
  emptyTitle: "Aún no hay nada",
  deprecated: "obsoleto",
  documented: "documentado",
  eolBanner: "Esta versión ya no tiene soporte.",
  brewedWith: "Elaborado con",
  tagline: "Brew your docs, serve them hot.",
};

const FR: Partial<UiStrings> = {
  parameters: "Paramètres",
  returns: "Retours",
  members: "Membres",
  throws: "Lève",
  see: "Voir",
  example: "Exemple",
  version: "Version :",
  searchPlaceholder: "Rechercher…  (⌘K / Ctrl+K)",
  searchDocs: "Rechercher",
  noResults: "Aucun résultat",
  skipToContent: "Aller au contenu",
  toggleTheme: "Changer de thème",
  tableOfContents: "Sommaire",
  onThisPage: "Sur cette page",
  guides: "Guides",
  backToDocs: "Retour à la documentation",
  emptyTitle: "Rien de préparé",
  deprecated: "obsolète",
  documented: "documenté",
  eolBanner: "Cette version n'est plus maintenue.",
  brewedWith: "Infusé avec",
  tagline: "Brew your docs, serve them hot.",
};

const JA: Partial<UiStrings> = {
  parameters: "パラメータ",
  returns: "戻り値",
  members: "メンバー",
  throws: "例外",
  see: "関連",
  example: "例",
  version: "バージョン:",
  searchPlaceholder: "検索…  (⌘K / Ctrl+K)",
  searchDocs: "ドキュメントを検索",
  noResults: "結果なし",
  skipToContent: "本文へスキップ",
  toggleTheme: "テーマ切替",
  tableOfContents: "目次",
  onThisPage: "この見出し",
  guides: "ガイド",
  backToDocs: "ドキュメントへ戻る",
  emptyTitle: "まだ何もありません",
  deprecated: "非推奨",
  documented: "ドキュメント化",
  eolBanner: "このバージョンはサポートされていません。",
  brewedWith: " brewed with",
  tagline: "Brew your docs, serve them hot.",
};

const ID: Partial<UiStrings> = {
  parameters: "Parameter",
  returns: "Nilai kembali",
  members: "Anggota",
  throws: "Melempar",
  see: "Lihat",
  example: "Contoh",
  version: "Versi:",
  searchPlaceholder: "Cari dok…  (⌘K / Ctrl+K)",
  searchDocs: "Cari dokumentasi",
  noResults: "Tidak ada hasil",
  skipToContent: "Lompat ke isi",
  toggleTheme: "Ganti tema",
  tableOfContents: "Daftar isi",
  onThisPage: "Di halaman ini",
  guides: "Panduan",
  backToDocs: "Kembali ke dokumentasi",
  emptyTitle: "Belum ada yang diseduh",
  deprecated: "usang",
  documented: "terdokumentasi",
  eolBanner: "Versi ini tidak lagi dipelihara.",
  brewedWith: "Diseduh dengan",
  tagline: "Seduh dokmu, sajikan panas-panas.",
};

const DICTIONARIES: Record<string, Partial<UiStrings>> = {
  en: {},
  de: DE,
  es: ES,
  fr: FR,
  ja: JA,
  id: ID,
};

/** Human names for the `locales` listing (always endonyms). */
export const LOCALE_LABELS: Record<string, string> = {
  en: "English",
  de: "Deutsch",
  es: "Español",
  fr: "Français",
  ja: "日本語",
  id: "Bahasa Indonesia",
};

export function listLocales(): { code: string; label: string }[] {
  return Object.keys(DICTIONARIES).map((code) => ({
    code,
    label: LOCALE_LABELS[code] ?? code,
  }));
}

/** `id-ID`/`ID`/`pt`-style input → a known code, `"en"` fallback. */
export function normalizeLocale(locale: string | undefined): string {
  if (!locale) return "en";
  const base = locale.toLowerCase().split(/[-_]/)[0];
  return base in DICTIONARIES ? base : "en";
}

/** Full UI bundle for a locale (English fills any gaps). */
export function uiStrings(locale: string | undefined): UiStrings {
  const code = normalizeLocale(locale);
  return { ...EN, ...(DICTIONARIES[code] ?? {}) };
}
