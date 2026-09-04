export type ThemeVars = Record<string, string>;

export interface Theme {
  name: string;
  label: string;
  light: ThemeVars;
  dark: ThemeVars;
}

/**
 * Theme registry. Each theme only supplies CSS custom properties; the
 * structural stylesheet in render.ts consumes them, so switching themes
 * never touches layout — just the palette and type.
 */
export const THEMES: Record<string, Theme> = {
  coffee: {
    name: "coffee",
    label: "Coffee",
    light: {
      "--bg": "#fbf7f0",
      "--ink": "#2b2118",
      "--muted": "#7a6a58",
      "--accent": "#b5651d",
      "--card": "#fffdf9",
      "--line": "#e7ddd0",
      "--code-bg": "#2b2118",
      "--code-ink": "#f6efe6",
      "--font": '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
      "--heading-font": 'Georgia, "Times New Roman", serif',
      "--tok-comment": "#9b8b78",
      "--tok-string": "#3a9d5d",
      "--tok-keyword": "#c0392b",
      "--tok-number": "#b5651d",
      "--tok-fn": "#2b6cb0",
    },
    dark: {
      "--bg": "#1c1714",
      "--ink": "#f3e9dc",
      "--muted": "#b3a290",
      "--accent": "#e0934f",
      "--card": "#251e19",
      "--line": "#3a2f27",
      "--code-bg": "#14100d",
      "--code-ink": "#f3e9dc",
      "--font": '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
      "--heading-font": 'Georgia, "Times New Roman", serif',
      "--tok-comment": "#8a7f72",
      "--tok-string": "#7bd99a",
      "--tok-keyword": "#ff8a65",
      "--tok-number": "#e0a35e",
      "--tok-fn": "#7fb3ff",
    },
  },
  ink: {
    name: "ink",
    label: "Ink",
    light: {
      "--bg": "#ffffff",
      "--ink": "#141414",
      "--muted": "#6b6b6b",
      "--accent": "#c0392b",
      "--card": "#fafafa",
      "--line": "#e6e6e6",
      "--code-bg": "#141414",
      "--code-ink": "#f4f4f4",
      "--font": 'Georgia, "Iowan Old Style", "Times New Roman", serif',
      "--heading-font": 'Georgia, "Times New Roman", serif',
      "--tok-comment": "#9a9a9a",
      "--tok-string": "#2e8b57",
      "--tok-keyword": "#c0392b",
      "--tok-number": "#8a6d3b",
      "--tok-fn": "#1f6fb2",
    },
    dark: {
      "--bg": "#0e0e0e",
      "--ink": "#e8e8e8",
      "--muted": "#9a9a9a",
      "--accent": "#e74c3c",
      "--card": "#161616",
      "--line": "#2a2a2a",
      "--code-bg": "#000000",
      "--code-ink": "#e8e8e8",
      "--font": 'Georgia, "Iowan Old Style", "Times New Roman", serif',
      "--heading-font": 'Georgia, "Times New Roman", serif',
      "--tok-comment": "#777777",
      "--tok-string": "#6fcf97",
      "--tok-keyword": "#ff7b6b",
      "--tok-number": "#d3a04a",
      "--tok-fn": "#6fb3ff",
    },
  },
  matcha: {
    name: "matcha",
    label: "Matcha",
    light: {
      "--bg": "#f4f7f0",
      "--ink": "#243019",
      "--muted": "#5f7350",
      "--accent": "#5b8c3e",
      "--card": "#fbfff7",
      "--line": "#dce6d2",
      "--code-bg": "#243019",
      "--code-ink": "#eef4e6",
      "--font": '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
      "--heading-font": 'Georgia, "Times New Roman", serif',
      "--tok-comment": "#8a9a7c",
      "--tok-string": "#3f8f5b",
      "--tok-keyword": "#6b8e23",
      "--tok-number": "#9c6b1f",
      "--tok-fn": "#2f7d6b",
    },
    dark: {
      "--bg": "#131a10",
      "--ink": "#e6f0dc",
      "--muted": "#9bb389",
      "--accent": "#8bc34a",
      "--card": "#1a2415",
      "--line": "#2c3a22",
      "--code-bg": "#0f140c",
      "--code-ink": "#e6f0dc",
      "--font": '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
      "--heading-font": 'Georgia, "Times New Roman", serif',
      "--tok-comment": "#7d8f6e",
      "--tok-string": "#9fe0a8",
      "--tok-keyword": "#b6e36a",
      "--tok-number": "#e0bd6a",
      "--tok-fn": "#7fd6c0",
    },
  },
  newsprint: {
    name: "newsprint",
    label: "Newsprint",
    light: {
      "--bg": "#fbfbf7",
      "--ink": "#1a1a1a",
      "--muted": "#6b6b6b",
      "--accent": "#1a1a1a",
      "--card": "#ffffff",
      "--line": "#e2e2dc",
      "--code-bg": "#1a1a1a",
      "--code-ink": "#f5f5f0",
      "--font": '"Iowan Old Style", Georgia, "Times New Roman", serif',
      "--heading-font": '"Iowan Old Style", Georgia, serif',
      "--tok-comment": "#9a9a9a",
      "--tok-string": "#3a7d44",
      "--tok-keyword": "#444444",
      "--tok-number": "#7a5b2e",
      "--tok-fn": "#2b4f80",
    },
    dark: {
      "--bg": "#141414",
      "--ink": "#ededed",
      "--muted": "#9a9a9a",
      "--accent": "#ededed",
      "--card": "#1c1c1c",
      "--line": "#2e2e2e",
      "--code-bg": "#0d0d0d",
      "--code-ink": "#ededed",
      "--font": '"Iowan Old Style", Georgia, "Times New Roman", serif',
      "--heading-font": '"Iowan Old Style", Georgia, serif',
      "--tok-comment": "#7a7a7a",
      "--tok-string": "#7fce8c",
      "--tok-keyword": "#cccccc",
      "--tok-number": "#d3a04a",
      "--tok-fn": "#7fb3ff",
    },
  },
};

export const DEFAULT_THEME = "coffee";

export function getTheme(name?: string): Theme {
  return THEMES[name ?? DEFAULT_THEME] ?? THEMES[DEFAULT_THEME];
}

export function listThemes(): Theme[] {
  return Object.values(THEMES);
}
