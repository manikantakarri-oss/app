/** A client's brand colour turned into the portal's whole palette.
 *
 *  One colour in, every brand token out, for light and dark: buttons, links,
 *  the selected menu item, the logo tile, the home banner, charts. Text on a
 *  coloured surface is picked for contrast (WCAG 4.5:1 for button text, 3:1
 *  for links and accents), so a pale yellow or a near-black brand still
 *  reads. Used by the portal (applied pre-paint from a cached copy, then from
 *  the session) and by the deployer's live preview, so the two always match.
 */

export type Rgb = [number, number, number];

export const HEX_RE = /^#[0-9a-fA-F]{6}$/;
const WHITE: Rgb = [255, 255, 255];
const BLACK: Rgb = [0, 0, 0];
const INK_DARK: Rgb = [11, 21, 20];
const PAGE_DARK: Rgb = [15, 20, 19];

export function hexToRgb(hex: string): Rgb {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

export function rgbToHex([r, g, b]: Rgb): string {
  return "#" + [r, g, b].map((v) => Math.round(Math.max(0, Math.min(255, v))).toString(16).padStart(2, "0")).join("");
}

/** a mixed with b: t = 0 gives a, t = 1 gives b. */
export function mix(a: Rgb, b: Rgb, t: number): Rgb {
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
}

function lum([r, g, b]: Rgb) {
  const c = (v: number) => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
  };
  return 0.2126 * c(r) + 0.7152 * c(g) + 0.0722 * c(b);
}

export function contrast(a: Rgb, b: Rgb) {
  const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p);
  return (x + 0.05) / (y + 0.05);
}

/** Move `c` towards `to` until it reaches `ratio` against `bg` (or gives up). */
function reach(c: Rgb, bg: Rgb, ratio: number, to: Rgb): Rgb {
  let out = c;
  for (let i = 0; i < 20 && contrast(out, bg) < ratio; i++) out = mix(out, to, 0.08);
  return out;
}

const rgba = ([r, g, b]: Rgb, a: number) => `rgba(${Math.round(r)}, ${Math.round(g)}, ${Math.round(b)}, ${a})`;

export type Palette = Record<string, string>;

/** The brand tokens for one theme. Keys are CSS custom property names. */
export function palette(hex: string, theme: "light" | "dark"): Palette {
  const base = hexToRgb(hex);
  if (theme === "light") {
    const brand = reach(base, WHITE, 3, BLACK); // links, focus rings, tags on white
    const deep = mix(brand, BLACK, 0.2);
    const btnFrom = reach(mix(base, BLACK, 0.06), WHITE, 4.5, BLACK);
    const btnTo = mix(btnFrom, BLACK, 0.24);
    const btnInk = contrast(WHITE, btnFrom) >= 4.5 ? WHITE : INK_DARK;
    return {
      "--brand": rgbToHex(brand),
      "--brand-ink": rgbToHex(contrast(WHITE, brand) >= 4.5 ? WHITE : INK_DARK),
      "--brand-deep": rgbToHex(deep),
      "--brand-soft": rgbToHex(mix(base, WHITE, 0.88)),
      "--chart-1": rgbToHex(deep),
      "--side-active": rgbToHex(mix(base, WHITE, 0.9)),
      "--side-accent": rgbToHex(deep),
      "--btn-from": rgbToHex(btnFrom),
      "--btn-to": rgbToHex(btnTo),
      "--btn-ink": rgbToHex(btnInk),
      "--btn-glow": rgba(deep, 0.5),
      "--hero-from": rgbToHex(deep),
      "--hero-to": rgbToHex(mix(base, [11, 20, 22], 0.8)),
      "--mark-from": rgbToHex(mix(base, WHITE, 0.15)),
      "--mark-to": rgbToHex(deep),
    };
  }
  const brand = reach(mix(base, WHITE, 0.15), PAGE_DARK, 4.5, WHITE); // readable on the dark page
  const btnFrom = mix(brand, WHITE, 0.12);
  const btnTo = mix(brand, BLACK, 0.12);
  const btnInk = contrast(INK_DARK, btnTo) >= 4.5 ? INK_DARK : WHITE;
  return {
    "--brand": rgbToHex(brand),
    "--brand-ink": rgbToHex(contrast(INK_DARK, brand) >= 4.5 ? INK_DARK : WHITE),
    "--brand-deep": rgbToHex(mix(brand, BLACK, 0.12)),
    "--brand-soft": rgbToHex(mix(base, PAGE_DARK, 0.8)),
    "--chart-1": rgbToHex(mix(brand, BLACK, 0.1)),
    "--side-active": rgba(brand, 0.16),
    "--side-accent": rgbToHex(brand),
    "--btn-from": rgbToHex(btnFrom),
    "--btn-to": rgbToHex(btnTo),
    "--btn-ink": rgbToHex(btnInk),
    "--btn-glow": rgba(brand, 0.35),
    "--hero-from": rgbToHex(mix(base, BLACK, 0.45)),
    "--hero-to": rgbToHex(mix(base, [10, 15, 15], 0.88)),
    "--mark-from": rgbToHex(mix(brand, WHITE, 0.1)),
    "--mark-to": rgbToHex(mix(base, BLACK, 0.15)),
  };
}

const decl = (p: Palette) =>
  Object.entries(p)
    .map(([k, v]) => `${k}:${v}`)
    .join(";");

/** A stylesheet that overrides the default teal in both themes. `html:root`
 *  outranks the `:root` rules in globals.css whatever the load order. */
export function brandCss(hex: string): string {
  if (!HEX_RE.test(hex)) return "";
  const light = decl(palette(hex, "light"));
  const dark = decl(palette(hex, "dark"));
  return (
    `html:root{${light}}` +
    `@media (prefers-color-scheme: dark){html:root:not([data-theme="light"]){${dark}}}` +
    `html:root[data-theme="dark"]{${dark}}`
  );
}

/** Warnings worth showing whoever picks the colour. */
export function colourNotes(hex: string): string[] {
  if (!HEX_RE.test(hex)) return [];
  const base = hexToRgb(hex);
  const notes: string[] = [];
  if (contrast(base, WHITE) < 3) notes.push("Very light on white, so links and buttons use a deeper shade of it.");
  if (contrast(base, PAGE_DARK) < 3) notes.push("Very dark on the dark theme, so dark mode uses a lighter shade of it.");
  const [r, g, b] = base;
  if (Math.max(r, g, b) - Math.min(r, g, b) < 24) notes.push("Close to grey: the portal will look neutral rather than branded.");
  return notes;
}

/** The most vivid common colour in an image: a sensible brand colour to
 *  suggest from a logo. Ignores near-white, near-black and transparent pixels. */
export function dominantColour(data: Uint8ClampedArray): string {
  const buckets = new Map<number, { n: number; r: number; g: number; b: number; sat: number }>();
  for (let i = 0; i < data.length; i += 4) {
    const [r, g, b, a] = [data[i], data[i + 1], data[i + 2], data[i + 3]];
    if (a < 200) continue;
    const max = Math.max(r, g, b);
    const min = Math.min(r, g, b);
    if (max > 240 && min > 230) continue; // white
    if (max < 30) continue; // black
    const key = ((r >> 5) << 6) | ((g >> 5) << 3) | (b >> 5);
    const e = buckets.get(key) || { n: 0, r: 0, g: 0, b: 0, sat: 0 };
    e.n++;
    e.r += r;
    e.g += g;
    e.b += b;
    e.sat += max - min;
    buckets.set(key, e);
  }
  let best: { score: number; c: Rgb } | null = null;
  buckets.forEach((e) => {
    const score = e.n * (1 + e.sat / e.n / 64);
    if (!best || score > best.score) best = { score, c: [e.r / e.n, e.g / e.n, e.b / e.n] };
  });
  return best ? rgbToHex((best as { c: Rgb }).c) : "";
}

/** Key under which the portal caches its brand stylesheet, applied before
 *  first paint by the boot script in layout.tsx (no flash of the default). */
export const BRAND_CACHE = "agent-portal-brand";

export function applyBrand(hex: string) {
  if (typeof document === "undefined") return;
  const css = brandCss(hex);
  let el = document.getElementById("brand-css") as HTMLStyleElement | null;
  if (!css) {
    el?.remove();
  } else {
    if (!el) {
      el = document.createElement("style");
      el.id = "brand-css";
      document.head.appendChild(el);
    }
    el.textContent = css;
  }
  try {
    if (css) localStorage.setItem(BRAND_CACHE, css);
    else localStorage.removeItem(BRAND_CACHE);
  } catch {
    // Only a cache; the session applies the brand anyway.
  }
}
