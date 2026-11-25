// Themes: the colour maths, every preset and any colours of your own staying readable, what's saved and how an older
// saved shape is read, and that OLED black (the look styles.css draws by itself) sets nothing.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  ACCENT_SWATCHES,
  BACKGROUND_SWATCHES,
  contrast,
  CUSTOM_THEME,
  customFromPreset,
  customSpec,
  DEFAULT_CUSTOM,
  DEFAULT_SETTINGS,
  deserialize,
  GRADIENT_STARTS,
  gradientCss,
  groundOf,
  hasBackdrop,
  isPristine,
  luminance,
  migrate,
  mix,
  OLED_VARS,
  onColor,
  over,
  paintFor,
  paintOf,
  parseColor,
  PRESET_GROUPS,
  PRESETS,
  presetById,
  previewVars,
  readable,
  serialize,
  toCss,
  toHex,
  TEXTURE_ATTR,
  textureAttr,
  TEXTURES,
  hasSeeThrough,
  type CustomTheme,
  type Rgb,
  type Rgba,
  type Texture,
  type ThemeSettings,
  type ThemeSpec,
} from "./theme";
import { pictureStats } from "./themeDevice";

const hex = (s: string): Rgb => parseColor(s)!;
/** A CSS colour the engine wrote: `#rrggbb` or `rgba(r, g, b, a)`. */
function css(text: string): Rgba {
  const m = /^rgba\((\d+), (\d+), (\d+), ([\d.]+)\)$/.exec(text);
  if (m) return { r: +m[1], g: +m[2], b: +m[3], a: +m[4] };
  const c = parseColor(text);
  if (!c) throw new Error(`not a colour: ${text}`);
  return { ...c, a: 1 };
}

const custom = (c: Partial<CustomTheme>): ThemeSettings => ({ ...DEFAULT_SETTINGS, theme: CUSTOM_THEME, custom: { ...DEFAULT_CUSTOM, ...c } });

/**
 * The worst contrast of each kind of words, on the page and on each panel, over every colour the look's page gets to.
 * This is what "readable" means for a look, measured from what it paints.
 */
function worst(spec: ThemeSpec, calm = false, texture: Texture = "flat") {
  const v = paintOf(spec, "t", calm, texture).vars;
  const { grounds } = groundOf(spec);
  const on = (names: string[]) => grounds.flatMap((g) => [g, ...names.map((n) => over(css(v[n]), g))]);
  const least = (name: string, under: Rgb[]) => Math.min(...under.map((u) => contrast(hex(v[name]), u)));
  const panels = ["--surface", "--surface-2", "--surface-3", "--card-top", "--card-bottom", "--human-bubble", "--code-bg"];
  const bars = ["--chrome", "--pop", "--menu"].filter((n) => v[n]);
  return {
    text: least("--text", on([...panels, ...bars])),
    text2: least("--text-2", on([...panels, ...bars])),
    // The small words: on the page, on cards, on a button and on a code block's header.
    text3: least("--text-3", on(["--surface", "--surface-2", "--code-bg", "--card-top", "--card-bottom"])),
    accent: least("--accent", on(["--surface", "--surface-2", "--card-top", "--card-bottom"])),
    green: least("--green", on(["--surface", "--surface-2"])),
    orange: least("--orange", on(["--surface", "--surface-2"])),
    red: least("--red", on(["--surface", "--surface-2"])),
    // Words on a filled button, and on the accent.
    primary: contrast(hex(v["--primary-text"]), hex(v["--primary-bg"])),
    onAccent: contrast(hex(v["--accent-text"]), hex(v["--accent"])),
    send: contrast(hex(v["--on-text"]), hex(v["--text"])),
    vars: v,
  };
}

/**
 * Body words at 4.5:1 or better everywhere. The accent and the colours that carry a meaning stay the colour they are,
 * so over a gradient or a picture they're held to 3:1 (and the page is dimmed until they get there); on a plain page, 4.5:1.
 */
function expectReadable(spec: ThemeSpec, name: string, calm = false, texture: Texture = "flat") {
  const w = worst(spec, calm, texture);
  const said = (k: string, n: number) => `${name}: ${k} ${n.toFixed(2)}`;
  for (const k of ["text", "text2", "text3", "primary", "onAccent", "send"] as const) expect([said(k, w[k]), w[k] >= 4.5]).toEqual([said(k, w[k]), true]);
  for (const k of ["accent", "green", "orange", "red"] as const) expect([said(k, w[k]), w[k] >= (spec.backdrop ? 3 : 4.5)]).toEqual([said(k, w[k]), true]);
}

describe("colour maths", () => {
  test("colours are read from #rgb and #rrggbb, and anything else is no colour", () => {
    expect(parseColor("#fff")).toEqual({ r: 255, g: 255, b: 255 });
    expect(parseColor("3D95FF")).toEqual({ r: 61, g: 149, b: 255 });
    expect(parseColor(" #0a1022 ")).toEqual({ r: 10, g: 16, b: 34 });
    for (const bad of ["", "red", "#12", "#12345", "#gggggg", "rgb(0,0,0)", null, undefined, 7, {}]) expect(parseColor(bad)).toBeNull();
    expect(toHex({ r: 61.4, g: 149, b: 300 })).toBe("#3d95ff");
    expect(toCss({ r: 255, g: 255, b: 255, a: 0.08 })).toBe("rgba(255, 255, 255, 0.08)");
    expect(toCss({ r: 1, g: 2, b: 3, a: 1 })).toBe("#010203");
  });

  test("contrast is WCAG's", () => {
    expect(contrast(hex("#000"), hex("#fff"))).toBeCloseTo(21, 5);
    expect(contrast(hex("#fff"), hex("#000"))).toBeCloseTo(21, 5);
    expect(contrast(hex("#777"), hex("#777"))).toBe(1);
    // The numbers styles.css quotes for OLED black's small words.
    expect(contrast(hex("#7e7e83"), hex("#000000"))).toBeCloseTo(5.2, 1);
    expect(contrast(hex("#7e7e83"), hex("#111113"))).toBeCloseTo(4.7, 1);
    expect(luminance(hex("#fff"))).toBeCloseTo(1, 5);
    expect(luminance(hex("#000"))).toBe(0);
  });

  test("mixing and layering", () => {
    expect(toHex(mix(hex("#000"), hex("#fff"), 0.5))).toBe("#808080");
    expect(toHex(over({ r: 255, g: 255, b: 255, a: 0.5 }, hex("#000")))).toBe("#808080");
    expect(toHex(over({ r: 255, g: 0, b: 0, a: 1 }, hex("#00f")))).toBe("#ff0000");
    expect(toHex(onColor(hex("#3d95ff")))).toBe("#000000");
    expect(toHex(onColor(hex("#0032b1")))).toBe("#ffffff");
  });

  test("a colour is changed only as far as it takes to read, keeping its hue", () => {
    // Already readable: untouched.
    expect(readable(hex("#3d95ff"), [hex("#000")], 4.5)).toEqual(hex("#3d95ff"));
    // Pink on cream: darker, still pink (red the strongest part, blue above green).
    const pink = readable(hex("#ff6fb5"), [hex("#f2e9d0")], 4.5);
    expect(contrast(pink, hex("#f2e9d0"))).toBeGreaterThanOrEqual(4.5);
    expect(contrast(pink, hex("#f2e9d0"))).toBeLessThan(4.8);
    expect(pink.r).toBeGreaterThan(pink.b);
    expect(pink.b).toBeGreaterThan(pink.g);
    // Navy on black: lighter, still blue.
    const navy = readable(hex("#0a1a6a"), [hex("#000")], 4.5);
    expect(contrast(navy, hex("#000"))).toBeGreaterThanOrEqual(4.5);
    expect(navy.b).toBeGreaterThan(navy.r);
    // On every ground at once.
    const both = readable(hex("#808080"), [hex("#000"), hex("#333")], 4.5);
    expect(Math.min(contrast(both, hex("#000")), contrast(both, hex("#333")))).toBeGreaterThanOrEqual(4.5);
    // Nothing reads on both black and white at 4.5: the better of black and white comes back, never a throw.
    expect(["#000000", "#ffffff"]).toContain(toHex(readable(hex("#808080"), [hex("#000"), hex("#fff")], 4.5)));
    // A colour that must stay that colour stops short of white.
    const red = readable(hex("#ff5a5f"), [hex("#7a3040")], 7, true);
    expect(toHex(red)).not.toBe("#ffffff");
    expect(red.r).toBeGreaterThan(red.g + 20);
  });
});

describe("OLED black is the look the stylesheet draws by itself", () => {
  test("it paints nothing: no variable, no attribute, the page's own bar colour", () => {
    expect(paintFor(DEFAULT_SETTINGS)).toBeNull();
    expect(paintFor({ ...DEFAULT_SETTINGS, calm: true })).toBeNull();
    expect(paintFor(DEFAULT_SETTINGS, true)).toBeNull();
    expect(presetById("oled")?.spec).toBeNull();
    expect(PRESETS[0].id).toBe("oled");
    expect(isPristine(DEFAULT_SETTINGS)).toBe(true);
    // Your own theme kept while OLED black is in use still paints nothing.
    expect(paintFor({ ...custom({ accent: "#ff0000" }), theme: "oled" })).toBeNull();
  });

  test("what a preview of it is drawn with is what styles.css says", () => {
    const sheet = readFileSync(join(import.meta.dir, "styles.css"), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
    // Every :root block's variables, later ones winning, as the browser reads them.
    const inSheet: Record<string, string> = {};
    for (const block of sheet.matchAll(/(?:^|\n):root\s*\{([^}]*)\}/g)) for (const d of block[1].matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)) inSheet[d[1]] = d[2].trim();
    for (const [name, value] of Object.entries(OLED_VARS)) expect([name, inSheet[name]]).toEqual([name, value]);
  });

  test("every colour a theme sets has OLED black's own value in styles.css, so no theme means no change", () => {
    const sheet = readFileSync(join(import.meta.dir, "styles.css"), "utf8");
    const paint = paintOf(presetById("charcoal")!.spec!, "charcoal");
    // What only a rule in themes.css reads (a backdrop's layers, corners) needs no default.
    const themeOnly = /^--(r-|backdrop|chrome|pop|menu|glass)/;
    for (const name of Object.keys(paint.vars)) if (!themeOnly.test(name)) expect([name, new RegExp(`\\n\\s*${name}:`).test(sheet)]).toEqual([name, true]);
    // The literals the stylesheet had before themes, each now a variable's default.
    for (const [name, was] of Object.entries({ "--primary-bg": "#f5f5f7", "--primary-text": "#000", "--primary-hover": "#fff", "--on-text": "#000", "--on-orange": "#000", "--tick": "#fff", "--edge-focus": "rgba(255, 255, 255, 0.22)", "--edge-hover": "rgba(255, 255, 255, 0.3)", "--drawer": "#0a0a0b", "--term-bg": "#101012", "--term-screen": "#000000", "--term-text": "#e8e8ea", "--strip": "#1f1a12", "--strip-down": "#261315", "--strip-update": "#0d1a2b", "--strip-mac": "#1c1a28", "--purple": "#c58cff", "--gold": "#ffc23c", "--chip-model": "#f0b39c", "--chip-effort": "#d9b8ff", "--heat-cool": "#5ab0ff", "--heat-hot": "#ff5a3c", "--human-link": "white", "--human-code-bg": "rgba(255, 255, 255, 0.18)", "--human-code-text": "white" })) {
      expect([name, sheet.includes(`\n  ${name}: ${was};`)]).toEqual([name, true]);
    }
  });
});

describe("the presets", () => {
  test("there's a spread of them, each with a name, a group and a line about it", () => {
    expect(PRESETS.length).toBeGreaterThanOrEqual(12);
    expect(new Set(PRESETS.map((p) => p.id)).size).toBe(PRESETS.length);
    expect(new Set(PRESETS.map((p) => p.name)).size).toBe(PRESETS.length);
    for (const p of PRESETS) {
      expect(PRESET_GROUPS).toContain(p.group);
      expect(p.about.length).toBeGreaterThan(5);
      expect(p.id).not.toBe(CUSTOM_THEME);
    }
    const kinds = (test: (s: ThemeSpec) => boolean) => PRESETS.filter((p) => p.spec && test(p.spec)).map((p) => p.id);
    // At least two light ones, a few gradients, and Nebula (the colours the Liquid glass theme had).
    expect(kinds((s) => paintOf(s, "t").scheme === "light" && !s.backdrop).length).toBeGreaterThanOrEqual(2);
    expect(kinds((s) => s.backdrop?.kind === "gradient").length).toBeGreaterThanOrEqual(3);
    expect(presetById("nebula")?.name).toBe("Nebula");
    expect(presetById("glass")).toBeUndefined();
    for (const group of PRESET_GROUPS) expect(PRESETS.some((p) => p.group === group)).toBe(true);
  });

  for (const p of PRESETS.filter((p) => p.spec)) {
    test(`${p.name}: every kind of words reads on the page and on every panel`, () => {
      expectReadable(p.spec!, p.name);
      // And with see-through effects reduced.
      expectReadable(p.spec!, `${p.name}, solid panels`, true);
      const paint = paintOf(p.spec!, p.id);
      expect(paint.attrs["data-theme"]).toBe(p.id);
      expect(paint.attrs["data-scheme"]).toBe(paint.scheme);
      expect(paint.color).toBe(paint.vars["--bg"]);
      // A preset's colours are chosen to read as they are: nothing is dimmed to make them.
      expect(groundOf(p.spec!).veil).toBe(0);
      // Its accent is the one it names, not one bent to fit.
      expect(paint.vars["--accent"]).toBe(p.spec!.accent);
    });
  }

  test("plain themes are solid; gradient and glass themes are see-through over one backdrop", () => {
    for (const p of PRESETS.filter((p) => p.spec)) {
      const paint = paintOf(p.spec!, p.id);
      if (!p.spec!.backdrop) {
        expect(paint.attrs["data-backdrop"]).toBeUndefined();
        expect(paint.vars["--backdrop"]).toBeUndefined();
        for (const name of ["--surface", "--surface-2", "--surface-3", "--card-top", "--human-bubble", "--code-bg"]) expect([p.id, name, paint.vars[name].startsWith("#")]).toEqual([p.id, name, true]);
      } else {
        expect(paint.attrs["data-backdrop"]).toBe("gradient");
        expect(paint.attrs["data-glass"]).toBe("1");
        expect(paint.vars["--surface"]).toMatch(/^rgba\(/);
        expect(paint.vars["--glass-filter"]).toMatch(/blur\(\d+px\)/);
        // A veil layer first (see-through when none is needed), then the backdrop itself.
        expect(paint.vars["--backdrop"]).toMatch(/^linear-gradient\(rgba\(\d+, \d+, \d+, 0\), rgba\(\d+, \d+, \d+, 0\)\), (linear|radial)-gradient\(/);
      }
    }
    // As clear as it gets: Nebula under the Liquid glass texture.
    const glass = paintFor({ ...DEFAULT_SETTINGS, theme: "nebula", texture: "glass" })!;
    expect(glass.vars["--surface"]).toMatch(/^rgba\(255, 255, 255, 0\.0\d+\)$/);
    expect(glass.vars["--glass-edge"]).toContain("inset 0 1px 0 rgba(255, 255, 255,");
    expect(glass.vars["--glass-shine"]).toContain("linear-gradient(135deg");
    expect(glass.attrs["data-round"]).toBe("1");
  });

  test("with see-through effects reduced, panels are solid and nothing blurs, over the same backdrop", () => {
    for (const calm of [paintFor({ ...DEFAULT_SETTINGS, theme: "nebula", calm: true })!, paintFor({ ...DEFAULT_SETTINGS, theme: "nebula" }, true)!]) {
      expect(calm.attrs["data-glass"]).toBeUndefined();
      expect(calm.attrs["data-backdrop"]).toBe("gradient");
      expect(calm.vars["--glass-filter"]).toBe("none");
      for (const name of ["--surface", "--surface-2", "--surface-3", "--chrome", "--pop", "--menu", "--card-top"]) expect([name, calm.vars[name].startsWith("#")]).toEqual([name, true]);
      // Shadows that are listed beside others stay valid when they draw nothing.
      expect(calm.vars["--glass-edge"]).toBe("0 0 0 0 transparent");
      expect(calm.vars["--backdrop"]).toBe(paintFor({ ...DEFAULT_SETTINGS, theme: "nebula" })!.vars["--backdrop"]);
    }
    expect(hasBackdrop({ ...DEFAULT_SETTINGS, theme: "nebula" })).toBe(true);
    expect(hasBackdrop({ ...DEFAULT_SETTINGS, theme: "light" })).toBe(false);
    expect(hasBackdrop(DEFAULT_SETTINGS)).toBe(false);
  });
});

describe("Terminal", () => {
  const spec = presetById("terminal")!.spec!;
  const v = paintOf(spec, "terminal").vars;
  /** Green: its green is well over its red and its blue. */
  const green = (c: Rgb) => c.g > c.r * 1.5 && c.g > c.b * 1.5;

  test("the page is true black and the words are neon green, as the theme names them", () => {
    expect(v["--bg"]).toBe("#000000");
    expect(paintOf(spec, "terminal").color).toBe("#000000");
    expect(v["--text"]).toBe("#39ff14");
    expect(spec.ink).toBe("#39ff14");
    expect(contrast(hex(v["--text"]), hex("#000000"))).toBeGreaterThan(14);
    // The accent is a green of its own, so a link isn't lost among the words.
    expect(v["--accent"]).toBe(spec.accent);
    expect(v["--accent"]).not.toBe(v["--text"]);
    expect(green(hex(v["--accent"]))).toBe(true);
    // The main button is the words' green with black on it; a message of yours is in the same green.
    expect([v["--primary-bg"], v["--primary-text"], v["--human-text"], v["--term-text"]]).toEqual(["#39ff14", "#000000", "#39ff14", "#39ff14"]);
  });

  test("the quieter words are darker greens, each still readable on the page and on every panel", () => {
    const [text, text2, text3] = ["--text", "--text-2", "--text-3"].map((n) => hex(v[n]));
    for (const c of [text, text2, text3]) expect(green(c)).toBe(true);
    expect(luminance(text2)).toBeLessThan(luminance(text));
    expect(luminance(text3)).toBeLessThan(luminance(text2));
    const w = worst(spec);
    expect(w.text).toBeGreaterThanOrEqual(7);
    for (const k of ["text2", "text3", "accent", "green", "orange", "red", "primary", "onAccent", "send"] as const) expect([k, w[k] >= 4.5]).toEqual([k, true]);
  });

  test("panels are black with a trace of green, and nothing is see-through", () => {
    for (const name of ["--surface", "--surface-2", "--surface-3", "--card-top", "--card-bottom", "--human-bubble", "--code-bg", "--drawer"]) {
      const c = hex(v[name]);
      expect([name, v[name].startsWith("#"), green(c), luminance(c) < 0.03]).toEqual([name, true, true, true]);
    }
    expect(paintOf(spec, "terminal").attrs).toEqual({ "data-theme": "terminal", "data-scheme": "dark", "data-round": "1" });
  });
});

describe("textures", () => {
  const with_ = (theme: string, texture: Texture, more: Partial<ThemeSettings> = {}): ThemeSettings => ({ ...DEFAULT_SETTINGS, theme, texture, ...more });
  const GLASS_ONLY = ["--chrome", "--pop", "--menu", "--glass-filter", "--glass-edge", "--glass-shine", "--glass-shadow"];
  const OWN: ThemeSettings[] = [custom({ background: "#2b1a3a", accent: "#ffd60a" }), custom({ background: "#e8f1ea", accent: "#3ec468" }), custom({ base: "gradient" }), custom({ base: "gradient", gradient: { shape: "linear", angle: 135, stops: ["#ffd6e8", "#d6e4ff"] }, seeThrough: 30 })];
  const ALL: ThemeSettings[] = [...PRESETS.map((p) => with_(p.id, "flat")), ...OWN];

  test("there are three: Flat (as the app comes), Skeuomorphic and Liquid glass, each with a line about it", () => {
    expect(TEXTURES.map((t) => [t.id, t.name])).toEqual([["flat", "Flat"], ["skeuo", "Skeuomorphic"], ["glass", "Liquid glass"]]);
    for (const t of TEXTURES) expect(t.about.length).toBeGreaterThan(8);
    expect(DEFAULT_SETTINGS.texture).toBe("flat");
  });

  test("it's kept with the theme; a value saved before textures, or one that isn't a texture, is Flat", () => {
    for (const t of TEXTURES) {
      const s = with_("paper", t.id, { calm: true });
      expect(deserialize(serialize(s, paintFor(s)))).toEqual(s);
      expect(JSON.parse(serialize(s, paintFor(s))).texture).toBe(t.id);
    }
    expect(migrate({ v: 1, theme: "midnight", custom: DEFAULT_CUSTOM, calm: false })).toEqual(with_("midnight", "flat"));
    expect(migrate("paper").texture).toBe("flat");
    for (const bad of ["shiny", "", 3, null, ["glass"], { id: "glass" }, "Glass"]) expect(migrate({ theme: "ocean", texture: bad }).texture).toBe("flat");
    expect(migrate({ theme: "ocean", texture: "skeuo" })).toEqual(with_("ocean", "skeuo"));
    // A texture alone is something to keep: OLED black with one isn't "nothing chosen".
    expect(isPristine(with_("oled", "skeuo"))).toBe(false);
    expect(isPristine(with_("oled", "flat"))).toBe(true);
  });

  test("it's one attribute on the page's root, and none for Flat", () => {
    expect(TEXTURE_ATTR).toBe("data-texture");
    expect([textureAttr(with_("oled", "flat")), textureAttr(with_("oled", "skeuo")), textureAttr(with_("light", "glass"))]).toEqual([null, "skeuo", "glass"]);
    expect(textureAttr({ ...DEFAULT_SETTINGS, texture: "shiny" as Texture })).toBeNull();
    // index.html sets the same attribute from what's saved, before the app loads, with or without a paint.
    const html = readFileSync(join(import.meta.dir, "..", "index.html"), "utf8");
    expect(html).toContain('if (kept.texture === "skeuo" || kept.texture === "glass") root.setAttribute("data-texture", kept.texture);');
    expect(html.indexOf('root.setAttribute("data-texture"')).toBeLessThan(html.indexOf("if (!paint) return;"));
  });

  test("the Liquid glass theme of before textures is Nebula with the Liquid glass texture, and paints what it painted", () => {
    for (const was of ["glass", { theme: "glass" }, { preset: "glass" }, { v: 1, theme: "glass", custom: DEFAULT_CUSTOM, calm: false }]) expect(migrate(was)).toEqual(with_("nebula", "glass"));
    expect(migrate({ theme: "glass", calm: true, custom: { accent: "#ff0000" } })).toEqual({ ...with_("nebula", "glass", { calm: true }), custom: { ...DEFAULT_CUSTOM, accent: "#ff0000" } });
    expect(deserialize(JSON.stringify({ v: 1, theme: "glass", custom: DEFAULT_CUSTOM, calm: false, paint: { vars: {}, attrs: { "data-theme": "glass" }, color: "#000", scheme: "dark" } }))).toEqual(with_("nebula", "glass"));
    // What the theme was, as it was written: clear panels (glass 1), 28 px of blur, the full shine.
    const nebula = presetById("nebula")!.spec!;
    const { glassShine, ...own } = nebula;
    expect(glassShine).toBe(1);
    expect(own.glass).toBe(1);
    const was: ThemeSpec = { ...own, blur: 28, shine: 1 };
    expect([nebula.bg, nebula.accent, nebula.depth, nebula.round, nebula.backdrop?.kind]).toEqual(["#1b1450", "#b7daff", 1.2, 78, "css"]);
    expect(paintFor(migrate("glass"))).toEqual(paintOf(was, "nebula"));
    expect(paintFor(migrate({ theme: "glass", calm: true }))).toEqual({ ...paintOf(was, "nebula", true), attrs: { ...paintOf(was, "nebula", true).attrs, "data-glass": "1" }, vars: paintFor(with_("nebula", "glass", { calm: true }))!.vars });
    // Under Flat it's drawn like the other colourful ones: their blur and their soft shine.
    const aurora = presetById("aurora")!.spec!;
    expect([nebula.blur, nebula.shine]).toEqual([aurora.blur, aurora.shine]);
    expect(paintFor(with_("nebula", "flat"))!.vars["--glass-filter"]).toBe(paintFor(with_("aurora", "flat"))!.vars["--glass-filter"].replace("136%", "140%"));
  });

  test("Skeuomorphic is drawn by the stylesheet alone: what a theme paints is the same as under Flat", () => {
    for (const s of ALL) for (const calm of [false, true]) expect(paintFor({ ...s, texture: "skeuo", calm })).toEqual(paintFor({ ...s, calm }));
    expect(paintFor(with_("oled", "skeuo"))).toBeNull();
  });

  test("Liquid glass on a plain page changes none of the theme's colours: it adds the see-through layers and the edges", () => {
    for (const s of ALL.filter((s) => !hasBackdrop(s) && paintFor(s))) {
      const flat = paintFor(s)!;
      const glass = paintFor({ ...s, texture: "glass" })!;
      expect([s.theme, Object.keys(glass.vars).filter((k) => glass.vars[k] !== flat.vars[k]).sort()]).toEqual([s.theme, [...GLASS_ONLY].sort()]);
      expect(glass.attrs).toEqual({ ...flat.attrs, "data-glass": "1" });
      expect([glass.color, glass.scheme]).toEqual([flat.color, flat.scheme]);
      // The bars, sheets and menus let what's behind them through, blurred; over the page colour itself they come to
      // colours the theme's panels already have (so every word reads on them as it did).
      for (const name of ["--chrome", "--pop", "--menu"]) expect([s.theme, name, css(glass.vars[name]).a < 0.95]).toEqual([s.theme, name, true]);
      expect(glass.vars["--glass-filter"]).toMatch(/^saturate\(140%\) blur\(28px\)$/);
      const bg = hex(flat.vars["--bg"]);
      const near = (a: Rgb, b: Rgb) => Math.max(Math.abs(a.r - b.r), Math.abs(a.g - b.g), Math.abs(a.b - b.b)) <= 2;
      expect([s.theme, near(over(css(glass.vars["--chrome"]), bg), hex(flat.vars["--surface"]))]).toEqual([s.theme, true]);
      const sheet = flat.scheme === "dark" ? hex(flat.vars["--surface"]) : bg;
      expect([s.theme, near(over(css(glass.vars["--pop"]), bg), sheet)]).toEqual([s.theme, true]);
      expect(glass.vars["--glass-edge"]).toContain("inset 0 1px 0 rgba(255, 255, 255,");
      expect(glass.vars["--glass-shine"]).toContain("linear-gradient(");
    }
  });

  test("Liquid glass over a gradient or a picture changes none of the theme's colours either: its panels stay as see-through as they are", () => {
    const picture = custom({ base: "picture", picture: { ...DEFAULT_CUSTOM.picture, average: "#3a6ea5", lo: 0.02, hi: 0.8 } });
    /** What the glass may set: its own variables, and how strong lines are (a border's colour, not a word's). */
    const GLASS_MAY = [...GLASS_ONLY, "--sep", "--sep-strong", "--shadow-pop"];
    for (const s of [...ALL.filter(hasBackdrop), picture]) {
      const flat = paintFor(s)!;
      const glass = paintFor({ ...s, texture: "glass" })!;
      const spec = s.theme === CUSTOM_THEME ? customSpec(s.custom) : presetById(s.theme)!.spec!;
      expect((spec.glass ?? 0) > 0).toBe(true);
      expect([s.theme, Object.keys(glass.vars).filter((k) => glass.vars[k] !== flat.vars[k] && !GLASS_MAY.includes(k))]).toEqual([s.theme, []]);
      for (const name of ["--chrome", "--pop", "--menu"]) expect([s.theme, name, glass.vars[name]]).toEqual([s.theme, name, flat.vars[name]]);
      expect([glass.attrs, glass.color, glass.scheme]).toEqual([flat.attrs, flat.color, flat.scheme]);
      expect(Number(/blur\((\d+)px\)/.exec(glass.vars["--glass-filter"])![1])).toBeGreaterThanOrEqual(28);
      // The shine across a dark panel is no stronger than the look has it itself (Nebula was made for all of it), so
      // the quiet words on it read as they do under Flat; the rest of the glass is a glow under the upper edge.
      const across = (v: Record<string, string>) => Number(/linear-gradient\(135deg, rgba\(255, 255, 255, ([\d.]+)\)/.exec(v["--glass-shine"])?.[1] ?? 0);
      if (glass.scheme === "dark") {
        expect([s.theme, across(glass.vars) <= (s.theme === "nebula" ? 0.12 : Math.max(across(flat.vars), 0.12 * (spec.shine ?? 0)) + 0.001)]).toEqual([s.theme, true]);
        if (s.theme !== "nebula") expect(glass.vars["--glass-shine"]).toContain("linear-gradient(180deg, rgba(255, 255, 255, 0.09) 0, rgba(255, 255, 255, 0) 9px)");
      }
      expect(glass.vars["--glass-edge"]).toContain(`inset 0 1px 0 rgba(255, 255, 255, ${glass.scheme === "dark" ? 0.2 : 0.7})`);
      expectReadable(spec, `${s.theme}, Liquid glass`, false, "glass");
      expectReadable(spec, `${s.theme}, Liquid glass, solid`, true, "glass");
    }
    // Your own gradient with solid panels: they stay solid, and the bars and sheets over the gradient become glass.
    const solid = custom({ base: "gradient", seeThrough: 0 });
    const [flat, glass] = [paintFor(solid)!, paintFor({ ...solid, texture: "glass" })!];
    expect([flat.vars["--surface"].startsWith("#"), flat.vars["--chrome"].startsWith("#"), flat.attrs["data-glass"]]).toEqual([true, true, undefined]);
    expect([glass.vars["--surface"].startsWith("#"), css(glass.vars["--chrome"]).a < 0.6, css(glass.vars["--pop"]).a < 0.9, glass.attrs["data-glass"]]).toEqual([true, true, true, "1"]);
    expectReadable(customSpec(solid.custom), "your own gradient, solid panels, Liquid glass", false, "glass");
  });

  test("Liquid glass over OLED black sets only what the glass needs: the look the stylesheet draws stays its own", () => {
    const paint = paintFor(with_("oled", "glass"))!;
    expect(Object.keys(paint.vars).sort()).toEqual([...GLASS_ONLY].sort());
    expect(paint.attrs).toEqual({ "data-glass": "1" });
    expect([paint.color, paint.scheme]).toEqual(["#000000", "dark"]);
    // Over black its layers come to OLED black's own panel colour (within a shade): the words on them read as they do.
    for (const name of ["--chrome", "--pop"]) {
      const c = over(css(paint.vars[name]), hex("#000000"));
      expect([name, css(paint.vars[name]).a < 0.9, Math.abs(c.r - 0x11) <= 2 && Math.abs(c.b - 0x13) <= 3]).toEqual([name, true, true]);
    }
  });

  test("with see-through effects reduced, Liquid glass keeps its edges and shine, and nothing is see-through or blurred", () => {
    for (const s of [...ALL, with_("oled", "flat")]) {
      for (const calm of [paintFor({ ...s, texture: "glass", calm: true })!, paintFor({ ...s, texture: "glass" }, true)!]) {
        expect(calm.vars["--glass-filter"]).toBe("none");
        for (const name of ["--chrome", "--pop", "--menu", ...(calm.vars["--surface"] ? ["--surface", "--surface-2", "--surface-3", "--card-top", "--human-bubble"] : [])]) expect([s.theme, name, calm.vars[name].startsWith("#")]).toEqual([s.theme, name, true]);
        expect(calm.vars["--glass-edge"]).toContain("inset 0 1px 0 rgba(255, 255, 255,");
        expect(calm.vars["--glass-shine"]).toContain("linear-gradient(");
        expect(calm.attrs["data-glass"]).toBe("1");
      }
    }
    // The switch has something to reduce under this texture, on a plain page too.
    expect([hasSeeThrough(with_("light", "glass")), hasSeeThrough(with_("oled", "glass")), hasSeeThrough(with_("light", "skeuo")), hasSeeThrough(with_("aurora", "flat")), hasSeeThrough(with_("oled", "flat"))]).toEqual([true, true, false, true, false]);
  });

  test("the texture stylesheet changes how things are drawn and nothing else: no size, no place, no font, no colour of words", () => {
    const sheet = readFileSync(join(import.meta.dir, "styles", "textures.css"), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
    const props = new Set<string>();
    for (const block of sheet.matchAll(/\{([^{}]*)\}/g)) for (const d of block[1].split(";")) if (d.includes(":")) props.add(d.slice(0, d.indexOf(":")).trim());
    const drawn = /^(--(tx|gx)-[\w-]+|--csb-bg|background|background-image|background-color|box-shadow|border(-(top|right|bottom|left))?-color|text-shadow|(-webkit-)?backdrop-filter|border-top-(left|right)-radius)$/;
    expect([...props].filter((p) => !drawn.test(p))).toEqual([]);
    // Every rule is under a texture's attribute, or draws the picker's own previews: Flat is untouched.
    // (A list of selectors is split at its own commas, not at those inside :is(…).)
    const heads = [...sheet.replace(/@media[^{]*\{/g, "").matchAll(/(?:^|\})\s*([^{}]+)\{/g)].flatMap((m) => m[1].split(/,(?![^()]*\))/).map((h) => h.trim())).filter(Boolean);
    expect(heads.length).toBeGreaterThan(60);
    expect(heads.filter((h) => !/^:root(\[data-scheme="light"\])?\[data-texture="(skeuo|glass)"\]/.test(h) && !/^(:root(\[data-scheme="light"\])?(\[data-backdrop\])? )?\.xp-(flat|skeuo|glass)\b/.test(h))).toEqual([]);
  });
});

describe("your own theme", () => {
  const SHADES = ["00", "40", "80", "c0", "ff"];
  const PAGES = SHADES.flatMap((r) => SHADES.flatMap((g) => SHADES.map((b) => `#${r}${g}${b}`)));

  test("any page colour with any accent reads, with words light, dark or picked for you", () => {
    for (const background of PAGES) {
      for (const accent of ["#3d95ff", "#ffd60a", "#ff0000", "#00ff00", "#000000", "#ffffff", background]) {
        for (const text of ["auto", "light", "dark"] as const) expectReadable(customSpec({ ...DEFAULT_CUSTOM, base: "color", background, accent, text }), `${background} with ${accent}, ${text} words`);
      }
    }
  });

  test("words are light on a dark page and dark on a light one, unless you say", () => {
    const scheme = (c: Partial<CustomTheme>) => paintFor(custom(c))!.scheme;
    expect(scheme({ background: "#000000" })).toBe("dark");
    expect(scheme({ background: "#12131a" })).toBe("dark");
    expect(scheme({ background: "#ffffff" })).toBe("light");
    expect(scheme({ background: "#f6f0e4" })).toBe("light");
    expect(scheme({ background: "#ffd60a" })).toBe("light");
    expect(scheme({ background: "#7a1fa2" })).toBe("dark");
    // Said outright, the page is dimmed or lightened until those words read: it's never ignored.
    expect(scheme({ background: "#ffffff", text: "light" })).toBe("dark");
    expect(scheme({ background: "#000000", text: "dark" })).toBe("light");
    const forced = paintFor(custom({ background: "#ffffff", text: "light" }))!;
    expect(contrast(hex(forced.vars["--text"]), hex(forced.vars["--bg"]))).toBeGreaterThanOrEqual(4.5);
    expect(luminance(hex(forced.vars["--bg"]))).toBeLessThan(0.2);
    // A page colour that reads as it is stays exactly yours.
    for (const background of BACKGROUND_SWATCHES) expect(paintFor(custom({ background }))!.vars["--bg"]).toBe(background);
  });

  test("an accent that reads is kept as it is; one that doesn't keeps its hue", () => {
    for (const accent of ACCENT_SWATCHES) expect(paintFor(custom({ accent, background: "#000000" }))!.vars["--accent"]).toBe(accent);
    const onWhite = hex(paintFor(custom({ accent: "#ffd60a", background: "#ffffff" }))!.vars["--accent"]);
    expect(contrast(onWhite, hex("#fff"))).toBeGreaterThanOrEqual(4.5);
    // Still a yellow-brown: red and green well above blue.
    expect(Math.min(onWhite.r, onWhite.g)).toBeGreaterThan(onWhite.b + 40);
  });

  test("any gradient reads, top to bottom: a bright end is dimmed just enough", () => {
    const stops = ["#000000", "#ffffff", "#ff0000", "#00ff00", "#0000ff", "#ffd400", "#7a1fa2", "#808080"];
    for (const a of stops) {
      for (const b of stops) {
        for (const text of ["auto", "light", "dark"] as const) {
          for (const seeThrough of [0, 100]) expectReadable(customSpec({ ...DEFAULT_CUSTOM, base: "gradient", gradient: { shape: "linear", angle: 90, stops: [a, b] }, text, seeThrough }), `${a} to ${b}, ${text} words, ${seeThrough}% see-through`);
        }
      }
    }
    // The starts on offer need no dimming at all.
    for (const g of GRADIENT_STARTS) expect([g.name, groundOf(customSpec({ ...DEFAULT_CUSTOM, base: "gradient", gradient: g.gradient })).veil]).toEqual([g.name, 0]);
    // A dark gradient gets light words, a pale one dark words.
    expect(paintFor(custom({ base: "gradient", gradient: GRADIENT_STARTS[0].gradient }))!.scheme).toBe("dark");
    expect(paintFor(custom({ base: "gradient", gradient: GRADIENT_STARTS.find((g) => g.name === "Candy")!.gradient }))!.scheme).toBe("light");
    // Between red and green a gradient is darker than both: that part is counted too.
    expect(groundOf(customSpec({ ...DEFAULT_CUSTOM, base: "gradient", gradient: { shape: "linear", angle: 0, stops: ["#ff0000", "#00ff00"] } })).grounds.length).toBeGreaterThan(2);
  });

  test("a gradient is written as CSS, straight or round, with two or three colours", () => {
    expect(gradientCss({ shape: "linear", angle: 160, stops: ["#111111", "#222222"] })).toBe("linear-gradient(160deg, #111111, #222222)");
    expect(gradientCss({ shape: "radial", angle: 160, stops: ["#111111", "#222222", "#333333"] })).toBe("radial-gradient(120% 120% at 50% 0%, #111111, #222222, #333333)");
    const paint = paintFor(custom({ base: "gradient" }))!;
    expect(paint.attrs["data-backdrop"]).toBe("gradient");
    expect(paint.vars["--backdrop"]).toContain(gradientCss(DEFAULT_CUSTOM.gradient));
  });

  test("any picture reads: its veil is never less than its brightest and darkest parts need, however the sliders sit", () => {
    for (const [average, lo, hi] of [["#808080", 0, 1], ["#ffffff", 0.9, 1], ["#000000", 0, 0.02], ["#3a6ea5", 0.05, 0.7], ["#f2d16b", 0.3, 0.95]] as const) {
      for (const dim of [0, 50, 100]) {
        for (const text of ["auto", "light", "dark"] as const) {
          for (const seeThrough of [0, 100]) {
            const c: CustomTheme = { ...DEFAULT_CUSTOM, base: "picture", text, seeThrough, picture: { ...DEFAULT_CUSTOM.picture, average, lo, hi, dim, blur: 0 } };
            expectReadable(customSpec(c), `a picture ${average} (${lo} to ${hi}), dim ${dim}, ${text} words, ${seeThrough}% see-through`);
          }
        }
      }
    }
    const veil = (dim: number, average = "#3a6ea5", lo = 0.05, hi = 0.7) => groundOf(customSpec({ ...DEFAULT_CUSTOM, base: "picture", picture: { ...DEFAULT_CUSTOM.picture, average, lo, hi, dim } })).veil;
    // Dim at nothing is the least it takes, not none; more dim is always more veil, never past 90%.
    expect(veil(0)).toBeGreaterThan(0);
    expect(veil(50)).toBeGreaterThan(veil(0));
    expect(veil(100)).toBeCloseTo(0.9, 5);
    // A dark picture needs none.
    expect(veil(0, "#0a0c14", 0, 0.02)).toBe(0);
  });

  test("a picture is painted by one layer: its blur, how it sits and where, over its own average colour", () => {
    const c = custom({ base: "picture", text: "light", picture: { average: "#3a6ea5", lo: 0.05, hi: 0.6, blur: 18, dim: 30, fit: "fit", x: 20, y: 80 } });
    const paint = paintFor(c)!;
    expect(paint.attrs["data-backdrop"]).toBe("picture");
    expect(paint.vars["--backdrop"]).toMatch(/^linear-gradient\(rgba\(0, 0, 0, 0\.\d+\), rgba\(0, 0, 0, 0\.\d+\)\), var\(--backdrop-picture, none\)$/);
    expect(paint.vars["--backdrop-blur"]).toBe("18px");
    expect(paint.vars["--backdrop-size"]).toBe("contain");
    expect(paint.vars["--backdrop-pos"]).toBe("20% 80%");
    // The page colour is the picture's own under its veil: what shows until the picture is read from the device.
    const { veil } = groundOf(customSpec(c.custom));
    expect(paint.vars["--bg"]).toBe(toHex(over({ r: 0, g: 0, b: 0, a: veil }, hex("#3a6ea5"))));
    // The picture itself never goes into what's saved.
    expect(serialize(c, paint)).not.toContain("blob:");
    // No picture chosen yet: your colours, and nothing of a backdrop.
    const none = paintFor(custom({ base: "picture" }))!;
    expect(none.attrs["data-backdrop"]).toBeUndefined();
    expect(none.vars["--bg"]).toBe(DEFAULT_CUSTOM.background);
    expect(hasBackdrop(custom({ base: "picture" }))).toBe(false);
  });

  test("panels go from solid to glass, and corners from square to round", () => {
    const at = (seeThrough: number, panelBlur = 20) => paintFor(custom({ base: "gradient", seeThrough, panelBlur }))!;
    expect(at(0).vars["--surface"]).toMatch(/^#/);
    expect(at(0).attrs["data-glass"]).toBeUndefined();
    expect(at(0).vars["--glass-filter"]).toBe("none");
    const a = (seeThrough: number) => css(at(seeThrough).vars["--surface"]).a;
    expect(a(50)).toBeLessThan(1);
    expect(a(100)).toBeLessThan(a(50));
    expect(at(100).vars["--glass-filter"]).toContain("blur(20px)");
    expect(at(100, 0).vars["--glass-filter"]).toBe("none");
    // A see-through panel looks the same over the page colour as the solid one does.
    const solid = hex(at(0).vars["--surface"]);
    const glass = over(css(at(60).vars["--surface"]), hex(at(60).vars["--bg"]));
    for (const k of ["r", "g", "b"] as const) expect(Math.abs(glass[k] - solid[k])).toBeLessThanOrEqual(1.5);
    // Over a plain colour there's nothing to see through.
    expect(paintFor(custom({ base: "color", seeThrough: 100 }))!.attrs["data-glass"]).toBeUndefined();

    const round = (n: number) => paintFor(custom({ round: n }))!;
    expect(round(50).attrs["data-round"]).toBeUndefined();
    expect(round(50).vars["--radius-lg"]).toBeUndefined();
    expect(round(0).vars["--radius-lg"]).toBe("3px");
    expect(round(100).vars["--radius-lg"]).toBe("28px");
    expect(round(100).attrs["data-round"]).toBe("1");
    expect(parseFloat(round(75).vars["--r-ctl"])).toBeGreaterThan(10);
    expect(parseFloat(round(25).vars["--r-ctl"])).toBeLessThan(10);
  });

  test("a preset can be the start of your own theme, keeping what the preset doesn't say", () => {
    const keep: CustomTheme = { ...DEFAULT_CUSTOM, picture: { ...DEFAULT_CUSTOM.picture, average: "#123456", blur: 30 } };
    const sunset = customFromPreset("sunset", keep);
    expect(sunset.base).toBe("gradient");
    expect(sunset.gradient.stops).toEqual(["#22104a", "#5e1746", "#702713"]);
    expect(sunset.accent).toBe("#ffbe7a");
    expect(sunset.picture).toEqual(keep.picture);
    const paper = customFromPreset("paper", keep);
    expect([paper.base, paper.background, paper.accent]).toEqual(["color", "#f6f0e4", "#9c4001"]);
    expect(customFromPreset("oled", keep).background).toBe("#000000");
    // Your own theme made from Paper looks like Paper where it matters.
    expect(paintFor(custom(paper))!.scheme).toBe("light");
  });
});

describe("what's kept on the device", () => {
  test("the settings and what they paint go out and come back whole", () => {
    const s: ThemeSettings = { v: 1, theme: "midnight", calm: true, texture: "skeuo", custom: { ...DEFAULT_CUSTOM, base: "gradient", accent: "#ff6fb5", round: 80 } };
    const text = serialize(s, paintFor(s));
    expect(deserialize(text)).toEqual(s);
    const kept = JSON.parse(text);
    // What index.html paints before the app loads.
    expect(kept.paint.vars["--bg"]).toBe("#0a1022");
    expect(kept.paint.attrs["data-theme"]).toBe("midnight");
    expect(kept.paint.color).toBe("#0a1022");
    // OLED black with a theme of your own kept: nothing to paint.
    expect(JSON.parse(serialize({ ...s, theme: "oled" }, null)).paint).toBeNull();
    expect(isPristine({ ...s, theme: "oled" })).toBe(false);
    expect(isPristine(deserialize(serialize(DEFAULT_SETTINGS, null)))).toBe(true);
  });

  test("an older or damaged value is read as far as it can be, and the rest is the default", () => {
    // The first shape: just a name.
    expect(migrate("midnight")).toEqual({ ...DEFAULT_SETTINGS, theme: "midnight" });
    expect(deserialize('"paper"').theme).toBe("paper");
    // Before it was called `theme`, and before "Reduce see-through effects" was `calm`.
    expect(migrate({ preset: "light", reduce: true })).toEqual({ ...DEFAULT_SETTINGS, theme: "light", calm: true });
    // Parts that came later are filled in.
    const older = migrate({ v: 1, theme: "custom", custom: { accent: "#F00", background: "#102030" } });
    expect(older.custom).toEqual({ ...DEFAULT_CUSTOM, accent: "#ff0000", background: "#102030" });
    // A preset that's gone, numbers out of range, a colour that isn't one, a gradient with one stop.
    const odd = migrate({ theme: "neon-2024", calm: "yes", custom: { base: "video", accent: "blue", seeThrough: 400, panelBlur: -3, round: "50", text: "pink", gradient: { shape: "spiral", angle: 999, stops: ["#fff"] }, picture: { average: "nope", blur: 99, dim: -1, fit: "stretch", x: 1e9, y: Number.NaN, lo: 0.8, hi: 0.2 } } });
    expect(odd.theme).toBe("oled");
    expect(odd.calm).toBe(false);
    expect(odd.custom).toEqual({ ...DEFAULT_CUSTOM, seeThrough: 100, panelBlur: 0, gradient: { ...DEFAULT_CUSTOM.gradient, angle: 360 }, picture: { average: null, lo: 0.8, hi: 0.8, blur: 40, dim: 0, fit: "fill", x: 100, y: 50 } });
    // Four stops are one too many.
    expect(migrate({ custom: { gradient: { stops: ["#111", "#222", "#333", "#444"] } } }).custom.gradient.stops).toEqual(["#111111", "#222222", "#333333"]);
    // Nothing, nonsense, or text that isn't JSON: the default, never a throw.
    for (const bad of [null, undefined, 7, [], true, { custom: 3 }, { theme: 12 }]) expect(migrate(bad)).toEqual(DEFAULT_SETTINGS);
    for (const bad of [null, undefined, "", "{", "not json"]) expect(deserialize(bad)).toEqual(DEFAULT_SETTINGS);
    // A value from a newer app keeps what this one understands.
    expect(migrate({ v: 9, theme: "ocean", somethingNew: { a: 1 } }).theme).toBe("ocean");
    // Whatever comes back always paints.
    expect(() => paintFor(odd)).not.toThrow();
    expect(() => paintFor({ ...odd, theme: CUSTOM_THEME })).not.toThrow();
  });

  test("a preview is drawn with the previewed look's own colours, never the one in use", () => {
    const names = Object.keys(OLED_VARS);
    for (const p of PRESETS) {
      const vars = previewVars(p.spec ? paintOf(p.spec, p.id) : null);
      for (const n of [...names, "--pv-page", "--pv-bar", "--pv-edge", "--pv-size", "--pv-pos"]) expect([p.id, n, typeof vars[n]]).toEqual([p.id, n, "string"]);
    }
    expect(previewVars(null)["--pv-page"]).toBe("#000000");
    expect(previewVars(paintOf(presetById("aurora")!.spec!, "aurora"))["--pv-page"]).toContain("linear-gradient(155deg");
    // Your own picture: its address goes into the preview's own backdrop.
    const picture = paintFor(custom({ base: "picture", picture: { ...DEFAULT_CUSTOM.picture, average: "#3a6ea5" } }))!;
    expect(previewVars(picture, "blob:abc")["--pv-page"]).toContain('url("blob:abc")');
    expect(previewVars(picture, null)["--pv-page"]).not.toContain("var(");
  });

  test("a picture's numbers: its colour on the whole, and how dark and bright it gets", () => {
    const pixels = (colours: [number, number, number][]) => new Uint8ClampedArray(colours.flatMap(([r, g, b]) => [r, g, b, 255]));
    expect(pictureStats(pixels([[0, 0, 0], [255, 255, 255]]))).toEqual({ average: "#808080", lo: 0, hi: 1 });
    const flat = pictureStats(pixels(Array(64).fill([58, 110, 165])));
    expect(flat.average).toBe("#3a6ea5");
    expect(flat.lo).toBe(flat.hi);
    // A few stray bright pixels in a dark picture don't count as its brightest part.
    const speck = pictureStats(pixels([...Array(99).fill([10, 10, 10]), [255, 255, 255]] as [number, number, number][]));
    expect(speck.hi).toBeLessThan(0.01);
    expect(pictureStats(new Uint8ClampedArray(0))).toEqual({ average: "#000000", lo: 0, hi: 0 });
  });
});
