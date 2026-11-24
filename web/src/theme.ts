/**
 * Themes: how the app looks on this device (Settings → This device → Theme).
 *
 * A theme is a small object (ThemeSettings: a preset's name, or your own colours, gradient or picture). Everything on
 * screen comes from the CSS variables it sets: `paintFor` works the whole set out from a few inputs (a page colour, an
 * accent, maybe a backdrop), keeping every kind of text readable on whatever ends up behind it. Nothing here touches
 * the page: themeDevice.ts keeps the choice on the device and applies it, index.html applies the saved one before the
 * first paint, and styles/themes.css holds the rules that only a theme with a backdrop needs.
 *
 * OLED black is the look styles.css draws by itself: it sets nothing, so a device that never chose a theme pays
 * nothing.
 */

// ------------------------------------------------------------ colour maths

export type Rgb = { r: number; g: number; b: number };
export type Rgba = Rgb & { a: number };
export type Scheme = "dark" | "light";

const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n));
const WHITE: Rgb = { r: 255, g: 255, b: 255 };
const BLACK: Rgb = { r: 0, g: 0, b: 0 };

/** `#rgb` or `#rrggbb` (any case, the # optional); null for anything else. */
export function parseColor(text: unknown): Rgb | null {
  if (typeof text !== "string") return null;
  const m = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(text.trim());
  if (!m) return null;
  const h = m[1].length === 3 ? [...m[1]].map((c) => c + c).join("") : m[1];
  return { r: parseInt(h.slice(0, 2), 16), g: parseInt(h.slice(2, 4), 16), b: parseInt(h.slice(4, 6), 16) };
}

const must = (text: string): Rgb => parseColor(text) ?? BLACK;
const byte = (n: number) => clamp(Math.round(n), 0, 255);
export const toHex = (c: Rgb) => `#${[c.r, c.g, c.b].map((n) => byte(n).toString(16).padStart(2, "0")).join("")}`;
/** As CSS: `#rrggbb`, or `rgba()` when it lets what's behind show. */
export const toCss = (c: Rgba) => (c.a >= 0.999 ? toHex(c) : `rgba(${byte(c.r)}, ${byte(c.g)}, ${byte(c.b)}, ${Math.round(clamp(c.a, 0, 1) * 1000) / 1000})`);
const alpha = (c: Rgb, a: number): Rgba => ({ ...c, a });

const linear = (v: number) => {
  const s = v / 255;
  return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
};
const unlinear = (l: number) => 255 * (l <= 0.0031308 ? l * 12.92 : 1.055 * l ** (1 / 2.4) - 0.055);

/** How bright a colour is, 0 (black) to 1 (white), as WCAG counts it. */
export const luminance = (c: Rgb) => 0.2126 * linear(c.r) + 0.7152 * linear(c.g) + 0.0722 * linear(c.b);

/** WCAG contrast between two colours, 1 (the same) to 21 (black on white). Body text needs 4.5. */
export function contrast(a: Rgb, b: Rgb): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

/** `t` of the way from `a` to `b`. */
export const mix = (a: Rgb, b: Rgb, t: number): Rgb => ({ r: a.r + (b.r - a.r) * t, g: a.g + (b.g - a.g) * t, b: a.b + (b.b - a.b) * t });

/** What a see-through colour looks like over a solid one. */
export const over = (top: Rgba, under: Rgb): Rgb => mix(under, top, clamp(top.a, 0, 1));

type Lab = { L: number; a: number; b: number };
function toOklab(c: Rgb): Lab {
  const [r, g, b] = [linear(c.r), linear(c.g), linear(c.b)];
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  return { L: 0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s, a: 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s, b: 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s };
}
function fromOklab({ L, a, b }: Lab): [number, number, number] {
  const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s = (L - 0.0894841775 * a - 1.291485548 * b) ** 3;
  return [4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s, -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s, -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s];
}

/** The same hue, as light as `L` (0 to 1): as much of its colour as a screen can show at that lightness. */
function relight(c: Rgb, L: number): Rgb {
  const lab = toOklab(c);
  const at = (k: number) => fromOklab({ L, a: lab.a * k, b: lab.b * k });
  const fits = (k: number) => at(k).every((v) => v >= -0.0005 && v <= 1.0005);
  let lo = 0;
  let hi = 1;
  if (!fits(1)) {
    for (let i = 0; i < 14; i++) {
      const mid = (lo + hi) / 2;
      if (fits(mid)) lo = mid;
      else hi = mid;
    }
    hi = lo;
  }
  // Whole bytes, as it will be written: what's measured is what's painted.
  const [r, g, b] = at(hi).map((v) => byte(unlinear(clamp(v, 0, 1))));
  return { r, g, b };
}

/** As light, or as dark, as a colour that says something may get and still be that colour (OKLCH lightness). */
const HUE_LIGHTEST = 0.84;
const HUE_DARKEST = 0.36;

/**
 * `c`, changed as little as it takes to read on every one of `grounds` at `ratio` or better: lighter or darker with
 * its hue kept. When no shade of it gets there, the black or white that reads best; or, with `keep`, the nearest shade
 * that is still that colour (a red that has to say "red" isn't made white to read a little better).
 */
export function readable(c: Rgb, grounds: Rgb[], ratio: number, keep = false): Rgb {
  const worst = (x: Rgb) => Math.min(...grounds.map((g) => contrast(x, g)));
  if (!grounds.length || worst(c) >= ratio) return c;
  // A little over, so rounding a panel's colour to whole bytes can't leave it a hair under.
  ratio += 0.06;
  const up = worst(WHITE) >= worst(BLACK);
  const from = toOklab(c).L;
  // As light or as dark as it may get: all the way, or while it still has its colour.
  const to = keep ? (up ? Math.max(from, HUE_LIGHTEST) : Math.min(from, HUE_DARKEST)) : up ? 1 : 0;
  const end = keep ? relight(c, to) : up ? WHITE : BLACK;
  if (worst(end) < ratio) return end;
  let lo = 0;
  let hi = 1;
  for (let i = 0; i < 16; i++) {
    const mid = (lo + hi) / 2;
    if (worst(relight(c, from + (to - from) * mid)) >= ratio) hi = mid;
    else lo = mid;
  }
  const out = relight(c, from + (to - from) * hi);
  return worst(out) >= ratio ? out : end;
}

/** Black or white, whichever reads better on `c` (the words on a button of that colour). */
export const onColor = (c: Rgb): Rgb => (contrast(BLACK, c) >= contrast(WHITE, c) ? BLACK : WHITE);

// ------------------------------------------------------------ what a theme is

export type GradientShape = "linear" | "radial";
export interface Gradient {
  shape: GradientShape;
  /** Degrees, as CSS counts them (180 runs top to bottom). A round one has no angle. */
  angle: number;
  /** Two or three colours. */
  stops: string[];
}

export type Backdrop =
  | ({ kind: "gradient" } & Gradient)
  /** Written by hand (Liquid glass's pools of colour): `colors` are the brightest and darkest it gets. */
  | { kind: "css"; css: string; colors: string[] }
  | { kind: "picture"; blur: number; dim: number; fit: PictureFit; x: number; y: number; average: string; lo: number; hi: number };

export type PictureFit = "fill" | "fit";

/** The few things a look is worked out from. */
export interface ThemeSpec {
  /** Light or dark words. Left out: whichever reads better on the page colour or the backdrop. */
  scheme?: Scheme;
  /** The page colour. Behind a backdrop it's worked out from the backdrop instead. */
  bg: string;
  accent: string;
  /** The words' colour, when it isn't the usual near-white or near-black. */
  ink?: string;
  /** What panels lean towards as they stand out from the page (white on dark, black on light, unless said). */
  tint?: string;
  /** How much panels stand out from the page: 1 as designed. */
  depth?: number;
  backdrop?: Backdrop;
  /** How see-through panels are over a backdrop, 0 (solid) to 1 (glass). */
  glass?: number;
  /** How much panels blur what's behind them, in pixels. */
  blur?: number;
  /** A light edge and a soft shine on panels, 0 to 1 (Liquid glass). */
  shine?: number;
  /** Corners, 0 (square) to 100 (round); 50 is as designed. */
  round?: number;
  /** Stronger lines and words (for reading in sunlight). */
  bold?: boolean;
}

export const PRESET_GROUPS = ["Dark", "Light", "Colourful"] as const;
export type PresetGroup = (typeof PRESET_GROUPS)[number];

export interface Preset {
  id: string;
  name: string;
  group: PresetGroup;
  /** One line under its name, for a reader and a pointer. */
  about: string;
  /** Null: the look styles.css draws by itself. */
  spec: ThemeSpec | null;
}

export const DEFAULT_THEME = "oled";
export const CUSTOM_THEME = "custom";

/** Liquid glass's backdrop: pools of colour over deep blue, bright enough to show through and dark enough to read on. */
const GLASS_POOLS: { css: string; colors: string[] } = {
  css: [
    "radial-gradient(65% 55% at 10% 6%, #74184f 0%, rgba(116, 24, 79, 0) 100%)",
    "radial-gradient(60% 50% at 94% 14%, #173aa3 0%, rgba(23, 58, 163, 0) 100%)",
    "radial-gradient(65% 55% at 80% 98%, #074f4d 0%, rgba(7, 79, 77, 0) 100%)",
    "radial-gradient(65% 60% at 4% 94%, #4a1d9a 0%, rgba(74, 29, 154, 0) 100%)",
    "linear-gradient(160deg, #0b1030, #130a2c)",
  ].join(", "),
  colors: ["#74184f", "#173aa3", "#074f4d", "#4a1d9a", "#0b1030", "#130a2c"],
};

/** The looks to pick from, in the order they're shown. */
export const PRESETS: Preset[] = [
  { id: "oled", name: "OLED black", group: "Dark", about: "True black. Easy on a phone's battery.", spec: null },
  { id: "charcoal", name: "Charcoal", group: "Dark", about: "Soft dark grey.", spec: { scheme: "dark", bg: "#17181c", accent: "#6aa9ff" } },
  { id: "midnight", name: "Midnight", group: "Dark", about: "Deep blue.", spec: { scheme: "dark", bg: "#0a1022", accent: "#7aa7ff", tint: "#bfd0ff", ink: "#eef2ff", depth: 1.15 } },
  { id: "ember", name: "Ember", group: "Dark", about: "Warm dark, like a low fire.", spec: { scheme: "dark", bg: "#16110e", accent: "#ff9a5a", tint: "#ffd2ad", ink: "#f6ede4", depth: 1.1 } },
  { id: "terminal", name: "Terminal", group: "Dark", about: "Green on black.", spec: { scheme: "dark", bg: "#020a05", accent: "#3df07a", tint: "#56ff95", ink: "#c5f7d2", depth: 1.05, round: 30 } },
  { id: "light", name: "Light", group: "Light", about: "Clean and bright.", spec: { scheme: "light", bg: "#ffffff", accent: "#045ed2", tint: "#14142b" } },
  { id: "paper", name: "Paper", group: "Light", about: "Warm, like a page.", spec: { scheme: "light", bg: "#f6f0e4", accent: "#9c4001", tint: "#5c3d14", ink: "#2a231c", depth: 1.25 } },
  { id: "sunlight", name: "Sunlight", group: "Light", about: "Strong contrast for reading outdoors.", spec: { scheme: "light", bg: "#ffffff", accent: "#0032b1", ink: "#000000", bold: true, depth: 1.5 } },
  {
    id: "aurora",
    name: "Aurora",
    group: "Colourful",
    about: "Green into violet.",
    spec: { scheme: "dark", bg: "#102a4c", accent: "#63e6c8", glass: 0.9, blur: 20, shine: 0.4, backdrop: { kind: "gradient", shape: "linear", angle: 155, stops: ["#06383a", "#12296b", "#431869"] } },
  },
  {
    id: "sunset",
    name: "Sunset",
    group: "Colourful",
    about: "Violet into ember.",
    spec: { scheme: "dark", bg: "#4d1846", accent: "#ffbe7a", glass: 0.9, blur: 20, shine: 0.4, backdrop: { kind: "gradient", shape: "linear", angle: 165, stops: ["#22104a", "#5e1746", "#702713"] } },
  },
  {
    id: "ocean",
    name: "Ocean",
    group: "Colourful",
    about: "Deep water.",
    spec: { scheme: "dark", bg: "#04304f", accent: "#78d9ff", glass: 0.9, blur: 20, shine: 0.4, backdrop: { kind: "gradient", shape: "linear", angle: 180, stops: ["#021226", "#04335a", "#054552"] } },
  },
  {
    id: "dawn",
    name: "Dawn",
    group: "Colourful",
    about: "Soft morning colours.",
    spec: { scheme: "light", bg: "#f3e8f4", accent: "#773adc", glass: 0.9, blur: 20, shine: 0.6, backdrop: { kind: "gradient", shape: "linear", angle: 155, stops: ["#ffe6d9", "#f0e4ff", "#d9efff"] } },
  },
  {
    id: "glass",
    name: "Liquid glass",
    group: "Colourful",
    about: "Clear panels over pools of colour.",
    spec: { scheme: "dark", bg: "#1b1450", accent: "#b7daff", glass: 1, blur: 28, shine: 1, depth: 1.2, round: 78, backdrop: { kind: "css", ...GLASS_POOLS } },
  },
];

export const presetById = (id: string): Preset | undefined => PRESETS.find((p) => p.id === id);

export type TextChoice = "auto" | "light" | "dark";
export type CustomBase = "color" | "gradient" | "picture";

/** The picture's own numbers, worked out once when it's chosen (themeDevice.ts); the picture itself isn't kept here. */
export interface PictureInfo {
  /** Its colour on the whole, shown until the picture itself is drawn. Null: no picture chosen. */
  average: string | null;
  /** How dark its darkest and how bright its brightest parts are (luminance, 0 to 1). */
  lo: number;
  hi: number;
  /** Pixels of blur, 0 to 40. */
  blur: number;
  /** A veil over it so words stay readable, 0 (as little as that takes) to 100. */
  dim: number;
  fit: PictureFit;
  /** Which part shows, 0 to 100 across and down. */
  x: number;
  y: number;
}

/** Your own theme. All of it is kept whichever base is in use, so switching between them loses nothing. */
export interface CustomTheme {
  base: CustomBase;
  accent: string;
  background: string;
  gradient: Gradient;
  picture: PictureInfo;
  /** How see-through panels are over a gradient or a picture, 0 (solid) to 100 (glass). */
  seeThrough: number;
  /** How much panels blur what's behind them, 0 to 40 pixels. */
  panelBlur: number;
  /** Corners, 0 (square) to 100 (round). */
  round: number;
  text: TextChoice;
}

export interface ThemeSettings {
  v: 1;
  /** A preset's id, or "custom". */
  theme: string;
  custom: CustomTheme;
  /** "Reduce see-through effects": panels are solid and nothing blurs. */
  calm: boolean;
}

export const DEFAULT_CUSTOM: CustomTheme = {
  base: "color",
  accent: "#3d95ff",
  background: "#12131a",
  gradient: { shape: "linear", angle: 160, stops: ["#1a1040", "#5b1a5e", "#9c2f45"] },
  picture: { average: null, lo: 0, hi: 1, blur: 12, dim: 20, fit: "fill", x: 50, y: 50 },
  seeThrough: 80,
  panelBlur: 20,
  round: 50,
  text: "auto",
};

export const DEFAULT_SETTINGS: ThemeSettings = { v: 1, theme: DEFAULT_THEME, custom: DEFAULT_CUSTOM, calm: false };

/** Good accents to start from. */
export const ACCENT_SWATCHES = ["#3d95ff", "#38bdf8", "#2dd4bf", "#3ec468", "#a3e635", "#ffd60a", "#ff9f43", "#ff5a5f", "#ff6fb5", "#a78bfa"];
/** Page colours to start from: dark ones, then light. */
export const BACKGROUND_SWATCHES = ["#000000", "#12131a", "#1d1e24", "#0a1022", "#101f1a", "#1f1326", "#1a1410", "#ffffff", "#f6f0e4", "#eaf0f7"];
/** Gradients to start from and change. */
export const GRADIENT_STARTS: { name: string; gradient: Gradient }[] = [
  { name: "Dusk", gradient: { shape: "linear", angle: 160, stops: ["#1a1040", "#5b1a5e", "#9c2f45"] } },
  { name: "Deep sea", gradient: { shape: "linear", angle: 180, stops: ["#03111f", "#0b4a6f"] } },
  { name: "Forest", gradient: { shape: "linear", angle: 150, stops: ["#0b1f14", "#1f5a3a"] } },
  { name: "Glow", gradient: { shape: "radial", angle: 0, stops: ["#6b2a8f", "#2a1458", "#0c0a1c"] } },
  { name: "Candy", gradient: { shape: "linear", angle: 135, stops: ["#ffd6e8", "#d6e4ff"] } },
  { name: "Mint", gradient: { shape: "linear", angle: 160, stops: ["#dcfbe9", "#d6f0ff", "#f3e8ff"] } },
];

// ------------------------------------------------------------ saved shape

const num = (v: unknown, lo: number, hi: number, fallback: number) => (typeof v === "number" && Number.isFinite(v) ? clamp(v, lo, hi) : fallback);
const color = (v: unknown, fallback: string) => {
  const c = parseColor(v);
  return c ? toHex(c) : fallback;
};
const oneOf = <T extends string>(v: unknown, all: readonly T[], fallback: T): T => (all.includes(v as T) ? (v as T) : fallback);
const record = (v: unknown): Record<string, unknown> => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {});

function gradientFrom(raw: unknown, fallback: Gradient): Gradient {
  const g = record(raw);
  const stops = Array.isArray(g.stops) ? g.stops.map((s) => parseColor(s)).filter((s): s is Rgb => !!s).map(toHex).slice(0, 3) : [];
  return { shape: oneOf(g.shape, ["linear", "radial"] as const, fallback.shape), angle: Math.round(num(g.angle, 0, 360, fallback.angle)), stops: stops.length >= 2 ? stops : [...fallback.stops] };
}

function customFrom(raw: unknown): CustomTheme {
  const c = record(raw);
  const p = record(c.picture);
  const d = DEFAULT_CUSTOM;
  const average = parseColor(p.average);
  const lo = num(p.lo, 0, 1, d.picture.lo);
  return {
    base: oneOf(c.base, ["color", "gradient", "picture"] as const, d.base),
    accent: color(c.accent, d.accent),
    background: color(c.background, d.background),
    gradient: gradientFrom(c.gradient, d.gradient),
    picture: {
      average: average ? toHex(average) : null,
      lo,
      hi: Math.max(lo, num(p.hi, 0, 1, d.picture.hi)),
      blur: Math.round(num(p.blur, 0, 40, d.picture.blur)),
      dim: Math.round(num(p.dim, 0, 100, d.picture.dim)),
      fit: oneOf(p.fit, ["fill", "fit"] as const, d.picture.fit),
      x: Math.round(num(p.x, 0, 100, d.picture.x)),
      y: Math.round(num(p.y, 0, 100, d.picture.y)),
    },
    seeThrough: Math.round(num(c.seeThrough, 0, 100, d.seeThrough)),
    panelBlur: Math.round(num(c.panelBlur, 0, 40, d.panelBlur)),
    round: Math.round(num(c.round, 0, 100, d.round)),
    text: oneOf(c.text, ["auto", "light", "dark"] as const, d.text),
  };
}

/**
 * Whatever was saved, as today's settings: a bare name (the first shape, before your own themes), an object missing
 * parts that came later, numbers out of range, a preset that's gone. Anything it can't read is the default, so a
 * damaged value never leaves the app unreadable.
 */
export function migrate(raw: unknown): ThemeSettings {
  if (typeof raw === "string") raw = { theme: raw };
  const s = record(raw);
  // Before `theme` it was `preset`.
  const named = typeof s.theme === "string" ? s.theme : typeof s.preset === "string" ? s.preset : DEFAULT_THEME;
  const theme = named === CUSTOM_THEME || presetById(named) ? named : DEFAULT_THEME;
  return { v: 1, theme, custom: customFrom(s.custom), calm: s.calm === true || s.reduce === true };
}

/** What's kept on the device: the settings, and what they paint (so the page can be painted before the app loads). */
export interface StoredTheme extends ThemeSettings {
  paint: Paint | null;
}

export const THEME_KEY = "crosstalk.theme.v1";

export function serialize(settings: ThemeSettings, paint: Paint | null): string {
  return JSON.stringify({ ...settings, paint } satisfies StoredTheme);
}

/** The saved text back as settings (null, damaged or older: see migrate). */
export function deserialize(text: string | null | undefined): ThemeSettings {
  if (!text) return DEFAULT_SETTINGS;
  try {
    return migrate(JSON.parse(text));
  } catch {
    return DEFAULT_SETTINGS;
  }
}

/** Nothing to keep: the default look and nothing of your own to remember. */
export const isPristine = (s: ThemeSettings) => JSON.stringify(s) === JSON.stringify(DEFAULT_SETTINGS);

// ------------------------------------------------------------ from a theme to what's painted

/** What a theme sets on the page. */
export interface Paint {
  /** CSS variables on the page's root. */
  vars: Record<string, string>;
  /** Attributes on the page's root (styles/themes.css keys its rules on them). */
  attrs: Record<string, string>;
  /** The browser's own bar (`<meta name="theme-color">`). */
  color: string;
  scheme: Scheme;
}

/** OLED black, as styles.css has it (theme.test.ts checks they agree): what a preview of it is drawn with. */
export const OLED_VARS: Record<string, string> = {
  "--bg": "#000000",
  "--surface": "#111113",
  "--surface-2": "#1b1b1e",
  "--surface-3": "#2a2a2e",
  "--text": "#f5f5f7",
  "--text-2": "#a1a1a6",
  "--text-3": "#7e7e83",
  "--sep": "rgba(255, 255, 255, 0.08)",
  "--sep-strong": "rgba(255, 255, 255, 0.14)",
  "--accent": "#3d95ff",
  "--accent-2": "rgba(61, 149, 255, 0.16)",
  "--accent-text": "#000000",
  "--green": "#3ec468",
  "--orange": "#ffa73a",
  "--red": "#ff5a5f",
  "--human-bubble": "#1f1f23",
  "--human-text": "#f5f5f7",
  "--code-bg": "#161619",
  "--card-top": "#141416",
  "--card-bottom": "#0d0d0f",
  "--radius-lg": "16px",
};

export function gradientCss(g: Gradient): string {
  const stops = g.stops.join(", ");
  return g.shape === "radial" ? `radial-gradient(120% 120% at 50% 0%, ${stops})` : `linear-gradient(${Math.round(g.angle)}deg, ${stops})`;
}

const grey = (lum: number): Rgb => {
  const v = unlinear(clamp(lum, 0, 1));
  return { r: v, g: v, b: v };
};

/** The colours a backdrop gets to: every one of them has to be readable on. */
function backdropColors(b: Backdrop): Rgb[] {
  if (b.kind === "picture") return [must(b.average), grey(b.lo), grey(b.hi)];
  const stops = (b.kind === "gradient" ? b.stops : b.colors).map(must);
  if (b.kind !== "gradient") return stops;
  // Between two stops a gradient can be darker than both (red into green passes through olive).
  const out: Rgb[] = [];
  stops.forEach((s, i) => {
    out.push(s);
    if (stops[i + 1]) for (const t of [0.25, 0.5, 0.75]) out.push(mix(s, stops[i + 1], t));
  });
  return out;
}

/** How dim a picture can get. */
const DIMMEST = 0.9;

type Tint = { c: Rgb; a: number };
/** Each panel as a tint over the page: how strong at full glass, in what colour. */
function tints(dark: boolean, backdrop: boolean, spec: ThemeSpec) {
  const d = spec.depth ?? 1;
  const t = (c: Rgb, a: number): Tint => ({ c, a: clamp(a * d, 0, 0.95) });
  if (dark) {
    const c = spec.tint ? must(spec.tint) : WHITE;
    // Over a backdrop the heaviest panel (a pill, a switch's track) stays light enough for quiet words to read on.
    const s3 = backdrop ? { c, a: Math.min(0.15, 0.166 * d) } : t(c, 0.166);
    return { s1: t(c, 0.068), s2: t(c, 0.108), s3, top: t(c, 0.08), bottom: t(c, 0.052), human: t(c, 0.125), code: t(c, 0.088), drawer: t(c, 0.04) };
  }
  if (backdrop) {
    // Light panels over a light backdrop are milky, not grey: lighter than what's behind them.
    const k = spec.tint ? must(spec.tint) : BLACK;
    return { s1: t(WHITE, 0.42), s2: t(WHITE, 0.62), s3: t(k, 0.075), top: t(WHITE, 0.5), bottom: t(WHITE, 0.36), human: t(WHITE, 0.7), code: t(WHITE, 0.46), drawer: t(WHITE, 0.3) };
  }
  const c = spec.tint ? must(spec.tint) : BLACK;
  return { s1: t(c, 0.036), s2: t(c, 0.068), s3: t(c, 0.12), top: t(c, 0.026), bottom: t(c, 0.044), human: t(c, 0.08), code: t(c, 0.042), drawer: t(c, 0.018) };
}

/** A veil of `colour` at `a` over each of `grounds`. */
const veiled = (grounds: Rgb[], colour: Rgb, a: number) => grounds.map((g) => over(alpha(colour, a), g));

/** The colours that say something (done, waiting, wrong), for light words and for dark. */
const HUES = { green: ["#3ec468", "#1c8a48"], orange: ["#ffa73a", "#b86200"], red: ["#ff5a5f", "#d42f3a"] } as const;
/**
 * The lightest veil (0 to DIMMEST) under which the page can be read: `ink` on every ground, plain and under the
 * heaviest panel, and the accent and the colours that say something, at their lightest or darkest, on the page and its panels (at
 * `hues`: 4.5 on a plain page; 3 over a gradient or a picture, which is dimmed less to stay itself).
 */
function veilFor(grounds: Rgb[], dark: boolean, ink: Rgb, accent: Rgb, T: ReturnType<typeof tints>, hues: number): number {
  const colour = dark ? BLACK : WHITE;
  // The accent is one of them: it's made lighter or darker to read, but stays the colour that was chosen.
  const ends = [accent, ...Object.values(HUES).map(([forDark, forLight]) => must(dark ? forDark : forLight))].map((c) => {
    const L = toOklab(c).L;
    return relight(c, dark ? Math.max(L, HUE_LIGHTEST) : Math.min(L, HUE_DARKEST));
  });
  const on = (t: Tint, g: Rgb) => over(alpha(t.c, t.a), g);
  for (let a = 0; a <= DIMMEST + 0.0001; a += 0.01) {
    const now = veiled(grounds, colour, a);
    if (now.every((g) => contrast(ink, g) >= 5.5 && contrast(ink, on(T.s3, g)) >= 4.6 && ends.every((e) => [g, on(T.s1, g), on(T.s2, g)].every((u) => contrast(e, u) >= hues + 0.1)))) return Math.round(a * 100) / 100;
  }
  return DIMMEST;
}

const px = (n: number) => `${Math.round(n * 10) / 10}px`;
/** A length that's `at50` as designed, `at0` square and `at100` round. */
const rounded = (round: number, at0: number, at50: number, at100: number) => (round <= 50 ? at0 + ((at50 - at0) * round) / 50 : at50 + ((at100 - at50) * (round - 50)) / 50);

/**
 * What a look's words end up over: light or dark words, the veil a backdrop needs for them to read, and every colour
 * the page gets to under that veil (one for a plain page; a gradient's stops and what's between them; a picture's
 * darkest, brightest and average).
 */
export function groundOf(spec: ThemeSpec) {
  const inkOf = (dark: boolean) => (spec.ink ? must(spec.ink) : spec.bold ? (dark ? WHITE : BLACK) : must(dark ? "#f5f5f7" : "#1d1d1f"));
  const raw = spec.backdrop ? backdropColors(spec.backdrop) : [must(spec.bg)];
  const floorOf = (dark: boolean) => veilFor(raw, dark, inkOf(dark), must(spec.accent), tints(dark, !!spec.backdrop, spec), spec.backdrop ? 3 : 4.5);
  // Light or dark words: as asked, else whichever needs less of a veil to read.
  const dark = spec.scheme ? spec.scheme === "dark" : floorOf(true) <= floorOf(false);
  const scheme: Scheme = dark ? "dark" : "light";
  const ink = inkOf(dark);
  const T = tints(dark, !!spec.backdrop, spec);
  const veilColour = dark ? BLACK : WHITE;
  const floor = floorOf(dark);
  const veil = spec.backdrop?.kind === "picture" ? floor + (DIMMEST - floor) * (clamp(spec.backdrop.dim, 0, 100) / 100) : floor;
  const grounds = veiled(raw, veilColour, veil);
  // The page colour: its own, or what the backdrop comes to on the whole.
  const bg = spec.backdrop ? (spec.backdrop.kind === "picture" ? grounds[0] : grounds.reduce((sum, g) => ({ r: sum.r + g.r / grounds.length, g: sum.g + g.g / grounds.length, b: sum.b + g.b / grounds.length }), { r: 0, g: 0, b: 0 })) : grounds[0];
  return { dark, scheme, ink, T, veil, veilColour, grounds, bg };
}

/**
 * Everything a look sets, worked out from its few inputs. `calm`: panels are solid and nothing blurs ("Reduce
 * see-through effects", or the device's own setting).
 */
export function paintOf(spec: ThemeSpec, id: string, calm = false): Paint {
  const { dark, scheme, ink, T, veil, veilColour, grounds, bg } = groundOf(spec);

  const glass = spec.backdrop && !calm ? clamp(spec.glass ?? 0, 0, 1) : 0;
  const blur = glass > 0 ? clamp(spec.blur ?? 0, 0, 40) : 0;
  const shine = glass * clamp(spec.shine ?? 0, 0, 1);
  /** A panel as a solid colour over the page colour. */
  const solid = (t: Tint) => over(alpha(t.c, t.a), bg);
  /** A panel as it's painted: solid, or letting `1 - a` of what's behind through while looking the same over the page colour. */
  const panel = (t: Tint, least = t.a): Rgba => {
    const a = 1 - glass * (1 - least);
    if (a >= 0.999) return alpha(solid(t), 1);
    const s = solid(t);
    const un = (top: number, under: number) => clamp((top - (1 - a) * under) / a, 0, 255);
    return { r: un(s.r, bg.r), g: un(s.g, bg.g), b: un(s.b, bg.b), a };
  };
  const s1 = panel(T.s1);
  const s2 = panel(T.s2);
  const s3 = panel(T.s3);
  const human = panel(T.human);
  const cards = [panel(T.top), panel(T.bottom)];
  const code = panel(T.code);
  // The layers over a backdrop: the bars (top bar, chat list, message box), what pops over the page (sheets, notices,
  // the drawer) and small menus, which stay nearly solid: they open inside a bar, where a blur can't reach what's
  // behind the bar.
  const chrome = panel(T.s1, dark ? 0.42 : 0.5);
  // Sheets and the drawer open over words, so they read without their blur too (a browser that doesn't draw one).
  const pop = panel(T.s2, dark ? 0.8 : 0.84);
  const menu = panel(T.s2, 0.93);
  // What words end up on: the page (every colour of a backdrop), and each panel over it, as it's written (whole bytes).
  const whole = (c: Rgba): Rgba => ({ r: byte(c.r), g: byte(c.g), b: byte(c.b), a: Math.round(c.a * 1000) / 1000 });
  const under = (...panels: Rgba[]) => grounds.flatMap((g) => [g, ...panels.map((p) => over(whole(p), g))]).map((c) => ({ r: byte(c.r), g: byte(c.g), b: byte(c.b) }));
  const plain = under(s1, s2, code, ...cards);
  const onPanels = under(s1, s2, ...cards);
  const anywhere = under(s1, s2, s3, human, code, chrome, pop, menu, ...cards);

  const text = readable(ink, anywhere, spec.backdrop ? 4.5 : 7);
  const text2 = readable(mix(bg, text, spec.bold ? 0.86 : dark ? 0.66 : 0.72), anywhere, spec.bold ? 7 : 4.5);
  // The small words also label a code block, on its header: the code's panel with a trace of the text colour over it.
  const codeHead = grounds.map((g) => over(alpha(text, 0.03), over(whole(code), g)));
  const text3 = readable(mix(bg, text, spec.bold ? 0.76 : dark ? 0.52 : 0.6), [...plain, ...codeHead], spec.bold ? 5.5 : 4.5);
  // The accent also sits on its own soft tint (the tab you're on, what's selected).
  const accentFirst = readable(must(spec.accent), onPanels, spec.bold ? 7 : 4.5, true);
  const accent = readable(accentFirst, [...onPanels, ...grounds.flatMap((g) => [s1, chrome].map((p) => over(alpha(accentFirst, dark ? 0.16 : 0.13), over(whole(p), g))))], spec.bold ? 7 : 4.5, true);
  /** A colour that says something (done, waiting, wrong): readable on the page, on panels and on its own soft chip. */
  const hue = (darkOne: string, lightOne: string) => {
    const start = must(dark ? darkOne : lightOne);
    const first = readable(start, onPanels, 4.5, true);
    return readable(first, [...onPanels, ...grounds.map((g) => over(alpha(first, 0.15), over(whole(s1), g)))], 4.5, true);
  };
  const green = hue(...HUES.green);
  const orange = hue(...HUES.orange);
  const red = hue(...HUES.red);
  const soft = (c: Rgb, a = dark ? 0.15 : 0.13) => toCss(alpha(c, a));
  const lines = spec.bold ? [0.32, 0.5] : dark ? [0.08 + 0.08 * shine, 0.14 + 0.12 * shine] : [0.1, 0.17];
  const round = clamp(spec.round ?? 50, 0, 100);
  const strip = (c: Rgb, a: number) => toHex(over(alpha(c, a), solid(T.s1)));

  const vars: Record<string, string> = {
    "--bg": toHex(bg),
    "--surface": toCss(s1),
    "--surface-2": toCss(s2),
    "--surface-3": toCss(s3),
    "--sidebar": toCss(alpha(bg, 0.92)),
    "--text": toHex(text),
    "--text-2": toHex(text2),
    "--text-3": toHex(text3),
    "--sep": toCss(alpha(text, lines[0])),
    "--sep-strong": toCss(alpha(text, lines[1])),
    "--accent": toHex(accent),
    "--accent-2": soft(accent, dark ? 0.16 : 0.13),
    "--accent-text": toHex(onColor(accent)),
    "--green": toHex(green),
    "--green-2": soft(green),
    "--orange": toHex(orange),
    "--orange-2": soft(orange),
    "--red": toHex(red),
    "--red-2": soft(red),
    "--human-bubble": toCss(human),
    "--human-text": toHex(text),
    "--human-link": toHex(text),
    "--human-code-bg": toCss(alpha(text, dark ? 0.16 : 0.08)),
    "--human-code-text": toHex(text),
    "--code-bg": toCss(code),
    "--card-top": toCss(cards[0]),
    "--card-bottom": toCss(cards[1]),
    "--shadow-pop": dark ? `0 12px 40px rgba(0, 0, 0, 0.55), 0 0 0 0.5px ${toCss(alpha(text, 0.14 + 0.1 * shine))}` : `0 12px 36px rgba(20, 20, 40, 0.16), 0 0 0 0.5px ${toCss(alpha(text, spec.bold ? 0.4 : 0.12))}`,
    "--primary-bg": toHex(text),
    "--primary-text": toHex(onColor(text)),
    "--primary-hover": toHex(mix(text, dark ? WHITE : BLACK, dark ? 1 : 0.35)),
    "--on-text": toHex(onColor(text)),
    "--on-orange": toHex(onColor(orange)),
    "--tick": toHex(onColor(accent)),
    "--edge-focus": toCss(alpha(text, dark ? 0.24 : 0.32)),
    "--edge-hover": toCss(alpha(text, dark ? 0.3 : 0.36)),
    "--drawer": toHex(solid(T.drawer)),
    "--term-bg": toHex(solid(T.drawer)),
    "--term-screen": toHex(solid(T.drawer)),
    "--term-text": toHex(text),
    "--strip": strip(orange, 0.12),
    "--strip-down": strip(red, 0.13),
    "--strip-update": strip(accent, 0.13),
    "--strip-mac": strip(must(dark ? "#8f7bff" : "#6a55e0"), 0.12),
    "--purple": toHex(readable(must(dark ? "#c58cff" : "#8a48d8"), onPanels, 4.5)),
    "--gold": toHex(readable(must(dark ? "#ffc23c" : "#a86a00"), onPanels, 4.5)),
    "--chip-model": toHex(readable(must(dark ? "#f0b39c" : "#a84a2a"), anywhere, 4.5)),
    "--chip-effort": toHex(readable(must(dark ? "#d9b8ff" : "#7a3fc4"), anywhere, 4.5)),
    "--heat-cool": toHex(readable(must(dark ? "#5ab0ff" : "#1f6fd6"), onPanels, 4.5)),
    "--heat-hot": toHex(readable(must(dark ? "#ff5a3c" : "#d63a1c"), onPanels, 4.5)),
  };
  const attrs: Record<string, string> = { "data-theme": id, "data-scheme": scheme };
  if (spec.bold) attrs["data-bold"] = "1";

  if (round !== 50) {
    attrs["data-round"] = "1";
    vars["--radius"] = px(rounded(round, 2, 12, 20));
    vars["--radius-lg"] = px(rounded(round, 3, 16, 28));
    vars["--r-ctl"] = px(rounded(round, 2, 10, 18));
    vars["--r-pop"] = px(rounded(round, 4, 20, 32));
    vars["--r-box"] = px(rounded(round, 3, 16, 26));
    vars["--r-bubble"] = px(rounded(round, 4, 20, 26));
    vars["--r-chip"] = px(rounded(round, 2, 12, 16));
  }

  if (spec.backdrop) {
    const b = spec.backdrop;
    attrs["data-backdrop"] = b.kind === "picture" ? "picture" : "gradient";
    const v = toCss(alpha(veilColour, veil));
    const veilLayer = `linear-gradient(${v}, ${v})`;
    // The picture itself is put in by themeDevice.ts once it's read from the device (--backdrop-picture).
    vars["--backdrop"] = `${veilLayer}, ${b.kind === "picture" ? "var(--backdrop-picture, none)" : b.kind === "gradient" ? gradientCss(b) : b.css}`;
    if (b.kind === "picture") {
      vars["--backdrop-blur"] = px(clamp(b.blur, 0, 40));
      vars["--backdrop-size"] = b.fit === "fit" ? "contain" : "cover";
      vars["--backdrop-pos"] = `${Math.round(clamp(b.x, 0, 100))}% ${Math.round(clamp(b.y, 0, 100))}%`;
    }
    vars["--chrome"] = toCss(chrome);
    vars["--pop"] = toCss(pop);
    vars["--menu"] = toCss(menu);
    vars["--glass-filter"] = blur > 0 ? `saturate(${Math.round(100 + 40 * glass)}%) blur(${px(blur)})` : "none";
    // Shadows that draw nothing when there's no shine: they're listed beside others, where `none` can't be.
    const NO_SHADOW = "0 0 0 0 transparent";
    vars["--glass-edge"] = shine > 0 ? `inset 0 1px 0 ${toCss(alpha(WHITE, (dark ? 0.2 : 0.7) * shine))}, inset 0 0 0 0.5px ${toCss(alpha(WHITE, (dark ? 0.1 : 0.4) * shine))}` : NO_SHADOW;
    vars["--glass-shine"] = shine > 0 ? `linear-gradient(135deg, ${toCss(alpha(WHITE, (dark ? 0.12 : 0.4) * shine))} 0%, ${toCss(alpha(WHITE, 0))} 42%, ${toCss(alpha(WHITE, 0))} 70%, ${toCss(alpha(WHITE, (dark ? 0.05 : 0.2) * shine))} 100%)` : "none";
    vars["--glass-shadow"] = shine > 0 ? `0 8px 32px ${toCss(alpha(dark ? BLACK : must("#30305a"), (dark ? 0.28 : 0.05) * shine))}` : NO_SHADOW;
    if (glass > 0) attrs["data-glass"] = "1";
  }
  return { vars, attrs, color: toHex(bg), scheme };
}

/** Your own theme as the inputs a look is worked out from. */
export function customSpec(c: CustomTheme): ThemeSpec {
  const scheme = c.text === "auto" ? undefined : c.text === "light" ? "dark" : "light";
  const base: ThemeSpec = { scheme, bg: c.background, accent: c.accent, round: c.round };
  const panels = { glass: c.seeThrough / 100, blur: c.panelBlur, shine: Math.max(0, (c.seeThrough - 40) / 60) * 0.7 };
  if (c.base === "gradient") return { ...base, ...panels, backdrop: { kind: "gradient", ...c.gradient } };
  // No picture chosen yet: your colours, until there is one.
  if (c.base === "picture" && c.picture.average) {
    const p = c.picture;
    return { ...base, ...panels, backdrop: { kind: "picture", blur: p.blur, dim: p.dim, fit: p.fit, x: p.x, y: p.y, average: p.average!, lo: p.lo, hi: p.hi } };
  }
  return base;
}

/**
 * What the settings paint, or null for the look styles.css draws by itself. `calm`: the device asks for less
 * see-through (prefers-reduced-transparency), as the settings' own switch does.
 */
export function paintFor(settings: ThemeSettings, calm = false): Paint | null {
  const still = calm || settings.calm;
  if (settings.theme === CUSTOM_THEME) return paintOf(customSpec(settings.custom), CUSTOM_THEME, still);
  const spec = presetById(settings.theme)?.spec;
  return spec ? paintOf(spec, settings.theme, still) : null;
}

/** Whether a theme has anything see-through to reduce. */
export function hasBackdrop(settings: ThemeSettings): boolean {
  if (settings.theme === CUSTOM_THEME) return !!customSpec(settings.custom).backdrop;
  return !!presetById(settings.theme)?.spec?.backdrop;
}

/** A preset as a start for your own theme ("Change this theme"): its colours and backdrop, yours to move from there. */
export function customFromPreset(id: string, keep: CustomTheme): CustomTheme {
  const spec = presetById(id)?.spec;
  const paint = spec ? paintOf(spec, id) : null;
  const background = paint ? paint.vars["--bg"] : OLED_VARS["--bg"];
  const accent = paint ? paint.vars["--accent"] : OLED_VARS["--accent"];
  const round = spec?.round ?? 50;
  if (spec?.backdrop?.kind === "gradient") {
    const { shape, angle, stops } = spec.backdrop;
    return { ...keep, base: "gradient", accent, gradient: { shape, angle, stops: [...stops] }, seeThrough: Math.round((spec.glass ?? 0) * 100), panelBlur: spec.blur ?? 0, round, text: "auto" };
  }
  return { ...keep, base: "color", accent, background, round, text: "auto" };
}

/**
 * What a small preview of a look is drawn with: every variable the preview uses, so none leaks in from the theme in
 * use around it. `picture`: the picture's address, for your own theme with one.
 */
export function previewVars(paint: Paint | null, picture?: string | null): Record<string, string> {
  const vars = { ...OLED_VARS, ...(paint?.vars ?? {}) };
  const backdrop = paint?.vars["--backdrop"]?.replace("var(--backdrop-picture, none)", picture ? `url("${picture}")` : "none");
  return {
    ...vars,
    "--pv-page": backdrop ? `${backdrop}, ${vars["--bg"]}` : vars["--bg"],
    "--pv-size": paint?.vars["--backdrop-size"] ?? "cover",
    "--pv-pos": paint?.vars["--backdrop-pos"] ?? "center",
    "--pv-bar": paint?.vars["--chrome"] ?? vars["--bg"],
    "--pv-edge": paint?.vars["--glass-edge"] ?? "0 0 0 0 transparent",
  };
}
