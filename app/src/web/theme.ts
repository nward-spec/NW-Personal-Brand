// Accent colour, chosen per device and remembered in localStorage. The rest of
// the palette (soft tint, text on accent) is derived so any colour stays legible.

export const ACCENT_KEY = 'weekly-journal:accent';
export const DEFAULT_ACCENT = '#6d5dfc';

export const ACCENT_PRESETS: { name: string; hex: string }[] = [
  { name: 'Violet', hex: '#6d5dfc' },
  { name: 'Ocean', hex: '#2f7cf6' },
  { name: 'Teal', hex: '#0f9d8a' },
  { name: 'Forest', hex: '#3d8b3d' },
  { name: 'Coral', hex: '#f0645c' },
  { name: 'Rose', hex: '#e04a8a' },
  { name: 'Amber', hex: '#d98a12' },
  { name: 'Slate', hex: '#4b5a75' },
];

const isHex = (v: string) => /^#[0-9a-f]{6}$/i.test(v);

/** Black or white text, whichever reads better on the colour. */
export function inkFor(hex: string): string {
  const r = parseInt(hex.slice(1, 3), 16) / 255;
  const g = parseInt(hex.slice(3, 5), 16) / 255;
  const b = parseInt(hex.slice(5, 7), 16) / 255;
  const lin = (c: number) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
  const luminance = 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
  return luminance > 0.4 ? '#14132a' : '#ffffff';
}

export function loadAccent(): string {
  try {
    const v = localStorage.getItem(ACCENT_KEY);
    return v && isHex(v) ? v : DEFAULT_ACCENT;
  } catch {
    return DEFAULT_ACCENT;
  }
}

export function applyAccent(hex: string) {
  const root = document.documentElement;
  if (hex === DEFAULT_ACCENT) {
    root.style.removeProperty('--accent');
    root.style.removeProperty('--accent-ink');
  } else {
    root.style.setProperty('--accent', hex);
    root.style.setProperty('--accent-ink', inkFor(hex));
  }
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', hex);
}

export function saveAccent(hex: string) {
  try {
    if (hex === DEFAULT_ACCENT) localStorage.removeItem(ACCENT_KEY);
    else localStorage.setItem(ACCENT_KEY, hex);
  } catch {
    /* ignore */
  }
  applyAccent(hex);
}
