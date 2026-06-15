// Theme tokens. Mirrors the dark/light token pattern you already use elsewhere —
// swap these for your real themes.js values to match the host app.

export const DARK = {
  bg: "#14161a",
  surface: "#1c1f26",
  surfaceAlt: "#23272f",
  text: "#e8eaed",
  muted: "#9aa0aa",
  border: "#2d323b",
  accent: "#7c9cff",
};

export const LIGHT = {
  bg: "#f6f7f9",
  surface: "#ffffff",
  surfaceAlt: "#eef0f4",
  text: "#1a1d23",
  muted: "#697080",
  border: "#e1e4ea",
  accent: "#4f6bed",
};

// Maps a token set to the CSS variables the components read.
export function toCssVars(t) {
  return {
    "--c-bg": t.bg,
    "--c-surface": t.surface,
    "--c-surface-alt": t.surfaceAlt,
    "--c-text": t.text,
    "--c-muted": t.muted,
    "--c-border": t.border,
    "--c-accent": t.accent,
  };
}
