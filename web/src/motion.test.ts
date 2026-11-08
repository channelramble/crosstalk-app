import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { quietSince, toMs } from "./motion";

/*
 * The motion rules (styles/motion.css's header), checked on every stylesheet and every source file, so a new rule that
 * breaks one fails here rather than stuttering on a phone. web/e2e/motion.spec.ts checks the same in the running app.
 */

const SRC = import.meta.dir;
const CSS_FILES = ["styles.css", ...readdirSync(join(SRC, "styles")).filter((f) => f.endsWith(".css")).map((f) => `styles/${f}`)];

/** Properties that move things by laying the page out again: never animated. */
const LAYOUT = /^(width|height|(min|max)-(width|height)|top|right|bottom|left|inset(-.+)?|margin(-.+)?|padding(-.+)?|border(-(top|right|bottom|left))?-width|font-size|line-height|letter-spacing|word-spacing|(row-|column-)?gap|flex(-.+)?|grid(-.+)?|order|display|position|float|zoom|vertical-align|text-indent)$/;
/** Properties that move things without laying anything out again: only with motion. */
const MOVES = new Set(["transform", "translate", "scale", "rotate"]);
const NO_PREFERENCE = /prefers-reduced-motion:\s*no-preference/;
const REDUCE = /prefers-reduced-motion:\s*reduce/;

type Decl = { file: string; selector: string; media: string[]; prop: string; value: string };
/** `order`: where it comes in its file, among the file's keyframes. */
type Frames = { file: string; name: string; media: string[]; order: number; frames: { at: string; decls: [string, string][] }[] };

/** Splits a declaration block (no nested rules in these stylesheets). */
const declarations = (body: string): [string, string][] =>
  body
    .split(";")
    .map((d) => d.trim())
    .filter((d) => d.includes(":"))
    .map((d) => [d.slice(0, d.indexOf(":")).trim().toLowerCase(), d.slice(d.indexOf(":") + 1).replace(/!important/, "").trim()]);

/** Every block `head { body }` at the top of `text`. */
function blocks(text: string): [string, string][] {
  const out: [string, string][] = [];
  let i = 0;
  while (i < text.length) {
    const open = text.indexOf("{", i);
    if (open < 0) break;
    let depth = 1;
    let k = open + 1;
    while (depth && k < text.length) {
      if (text[k] === "{") depth++;
      else if (text[k] === "}") depth--;
      k++;
    }
    out.push([text.slice(i, open).trim(), text.slice(open + 1, k - 1)]);
    i = k;
  }
  return out;
}

function parse(file: string) {
  // An @import has no block of its own (the stylesheet it names is read as its own file here).
  const css = readFileSync(join(SRC, file), "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/@import\s[^;]*;/g, "");
  const decls: Decl[] = [];
  const keyframes: Frames[] = [];
  const walk = (text: string, media: string[]) => {
    for (const [head, body] of blocks(text)) {
      if (head.startsWith("@keyframes")) keyframes.push({ file, name: head.split(/\s+/)[1], media, order: keyframes.length, frames: blocks(body).map(([at, b]) => ({ at, decls: declarations(b) })) });
      else if (head.startsWith("@media") || head.startsWith("@supports")) walk(body, [...media, head]);
      else for (const [prop, value] of declarations(body)) decls.push({ file, selector: head.replace(/\s+/g, " "), media, prop, value });
    }
  };
  walk(css, []);
  return { decls, keyframes };
}

const parsed = CSS_FILES.map(parse);
const DECLS = parsed.flatMap((p) => p.decls);
/** Every @keyframes, under each name: one for both settings, and one each setting may redefine it as. */
const ALL_KEYFRAMES = parsed.flatMap((p) => p.keyframes);
const KEYFRAMES = new Map<string, Frames[]>();
for (const k of ALL_KEYFRAMES) KEYFRAMES.set(k.name, [...(KEYFRAMES.get(k.name) ?? []), k]);
type Setting = "motion" | "reduce";
const SETTINGS: Setting[] = ["motion", "reduce"];
/** Which setting a block is for (null: both). */
const settingOf = (media: string[]): Setting | null => (media.some((m) => NO_PREFERENCE.test(m)) ? "motion" : media.some((m) => REDUCE.test(m)) ? "reduce" : null);
/** The keyframes a name plays under a setting: the setting's own definition, else the one for both. */
const framesFor = (name: string, setting: Setting): Frames | undefined => {
  const all = KEYFRAMES.get(name) ?? [];
  return all.find((k) => settingOf(k.media) === setting) ?? all.find((k) => settingOf(k.media) === null);
};
/** The settings a declaration applies under. */
const settingsOf = (d: Decl): Setting[] => {
  const own = settingOf(d.media);
  return own ? [own] : SETTINGS;
};
const where = (d: Decl) => `${d.file}: ${d.selector} { ${d.prop}: ${d.value} }`;

/** Splits at commas outside parentheses. */
const items = (value: string) => {
  const out: string[] = [];
  let depth = 0;
  let cur = "";
  for (const c of value) {
    if (c === "(") depth++;
    if (c === ")") depth--;
    if (c === "," && !depth) {
      out.push(cur.trim());
      cur = "";
    } else cur += c;
  }
  return [...out, cur.trim()].filter(Boolean);
};

/** What a `transition` or `transition-property` animates. */
const transitioned = (d: Decl) => (d.value === "none" ? [] : items(d.value).map((item) => (d.prop === "transition" ? item.split(/\s+/)[0] : item).toLowerCase()));
/** The keyframes an `animation` or `animation-name` plays. */
const played = (d: Decl) => (d.value === "none" ? [] : items(d.value).flatMap((item) => item.split(/\s+/).filter((w) => KEYFRAMES.has(w))));
/** Those of them that end (not the ones that go round for ever). */
const playedOnce = (d: Decl) => (d.value === "none" ? [] : items(d.value).filter((item) => !/\binfinite\b/.test(item)).flatMap((item) => item.split(/\s+/).filter((w) => KEYFRAMES.has(w))));
const framesProps = (k: Frames | undefined) => new Set((k?.frames ?? []).flatMap((f) => f.decls.map(([p]) => p)).filter((p) => p !== "animation-timing-function"));
const animations = DECLS.filter((d) => d.prop === "animation" || d.prop === "animation-name");
const transitions = DECLS.filter((d) => d.prop === "transition" || d.prop === "transition-property");
/** Whether it moves anything, under any setting it applies under. */
const moves = (d: Decl) =>
  d.prop.startsWith("transition") ? transitioned(d).some((p) => MOVES.has(p) || p === "all") : played(d).some((name) => settingsOf(d).some((s) => [...framesProps(framesFor(name, s))].some((p) => MOVES.has(p))));
const repeats = (d: Decl) => d.prop.startsWith("animation") && /\binfinite\b/.test(d.value);
/** A selector list, one selector at a time. */
const selectors = (d: Decl) => items(d.selector);

/** motion.css's tokens, for durations written as var(--dur-…). */
const TOKENS = new Map(DECLS.filter((d) => d.file === "styles/motion.css" && d.selector === ":root" && !d.media.length && d.prop.startsWith("--")).map((d) => [d.prop, d.value]));
const durations = (value: string) =>
  [...value.replace(/var\((--[\w-]+)\)/g, (_, name: string) => TOKENS.get(name) ?? "0ms").matchAll(/(?<![\w.-])(\d*\.?\d+)(ms|s)\b/g)].map((m) => toMs(m[0]));

describe("no animation ever lays the page out again", () => {
  test("transitions name the properties they animate, and none is a layout property", () => {
    expect(transitions.length).toBeGreaterThan(5);
    for (const d of transitions) {
      for (const p of transitioned(d)) {
        expect(p, where(d)).not.toBe("all");
        expect(LAYOUT.test(p), where(d)).toBe(false);
      }
    }
  });

  test("keyframes animate no layout property, and nothing the main thread has to work out", () => {
    for (const k of ALL_KEYFRAMES) {
      for (const p of framesProps(k)) {
        expect(LAYOUT.test(p), `${k.file}: @keyframes ${k.name} animates ${p}`).toBe(false);
        expect(p, `${k.file}: @keyframes ${k.name}`).not.toBe("z-index");
      }
    }
  });

  test("every animation plays keyframes that exist, under every setting it applies under", () => {
    for (const d of animations) {
      if (d.value === "none") continue;
      expect(played(d).length, where(d)).toBeGreaterThan(0);
      for (const name of played(d)) for (const s of settingsOf(d)) expect(framesFor(name, s), `${where(d)}: ${name} with ${s}`).toBeDefined();
    }
  });
});

describe("keyframes WebKit draws right", () => {
  test("a transform keyframe set is all % or all px, never both (WebKit zooms a mix twice)", () => {
    for (const k of ALL_KEYFRAMES) {
      const values = k.frames.flatMap((f) => f.decls.filter(([p]) => MOVES.has(p) && p !== "rotate").map(([, v]) => v));
      const percent = values.some((v) => /%/.test(v));
      const px = values.some((v) => /\dpx/.test(v));
      expect(percent && px, `${k.file}: @keyframes ${k.name}: ${values.join(" → ")}`).toBe(false);
    }
  });

  test("curves inside keyframes are written out: var() there is ignored", () => {
    for (const k of ALL_KEYFRAMES) {
      for (const f of k.frames) for (const [p, v] of f.decls) if (p === "animation-timing-function") expect(v.includes("var("), `${k.file}: @keyframes ${k.name}`).toBe(false);
    }
  });
});

describe("one Reduce Motion policy", () => {
  test("styles.css moves nothing itself: every animation and transition is in motion.css", () => {
    const own = parsed[0];
    expect(own.keyframes.map((k) => k.name)).toEqual([]);
    expect(own.decls.filter((d) => d.prop.startsWith("animation") || d.prop.startsWith("transition")).map(where)).toEqual([]);
  });

  test("in motion.css, everything that moves or repeats is in the no-preference block", () => {
    for (const d of [...animations, ...transitions].filter((d) => d.file === "styles/motion.css" && (moves(d) || repeats(d)))) {
      expect(d.media.some((m) => NO_PREFERENCE.test(m)), where(d)).toBe(true);
    }
  });

  test("anything in another stylesheet that moves or repeats is stood still under Reduce Motion", () => {
    const stood = DECLS.filter((d) => d.media.some((m) => REDUCE.test(m)) && (d.prop.startsWith("animation") || d.prop.startsWith("transition")));
    for (const d of [...animations, ...transitions].filter((d) => (moves(d) || repeats(d)) && !d.media.some((m) => NO_PREFERENCE.test(m)))) {
      const kind = d.prop.startsWith("animation") ? "animation" : "transition";
      const still = stood.some((r) => r.prop.startsWith(kind) && r.value === "none" && r.selector.split(",").map((s) => s.trim()).some((s) => d.selector.split(",").map((x) => x.trim()).includes(s)));
      expect(still, `${where(d)} has no Reduce Motion rule setting its ${kind} to none`).toBe(true);
    }
  });

  test("under Reduce Motion, what stands in is a fade of 150 ms or less, or nothing", () => {
    const reduce = DECLS.filter((d) => d.media.some((m) => REDUCE.test(m)));
    expect(reduce.length).toBeGreaterThan(5);
    for (const d of reduce.filter((d) => d.prop.startsWith("animation") && d.value !== "none")) {
      expect(repeats(d), where(d)).toBe(false);
      for (const name of played(d)) expect([...framesProps(framesFor(name, "reduce"))], `${where(d)}: ${name} as Reduce Motion has it`).toEqual(["opacity"]);
      for (const ms of durations(d.value)) expect(ms, where(d)).toBeLessThanOrEqual(150);
    }
    for (const d of reduce.filter((d) => d.prop.startsWith("transition") && d.value !== "none")) {
      for (const p of transitioned(d)) expect(MOVES.has(p), where(d)).toBe(false);
      for (const ms of durations(d.value)) expect(ms, where(d)).toBeLessThanOrEqual(150);
    }
  });

  test("what changes under both settings is a fade or a colour, 150 ms or less", () => {
    for (const d of [...animations, ...transitions].filter((d) => !d.media.some((m) => NO_PREFERENCE.test(m) || REDUCE.test(m)) && d.file === "styles/motion.css")) {
      expect(moves(d), where(d)).toBe(false);
      for (const ms of durations(d.value)) expect(ms, where(d)).toBeLessThanOrEqual(150);
    }
  });

  test("every motion token used is defined", () => {
    for (const d of DECLS) {
      for (const [, name] of d.value.matchAll(/var\((--(?:dur|ease|press)-[\w-]+)/g)) expect(TOKENS.has(name), `${where(d)} uses ${name}`).toBe(true);
    }
  });

  test("turning Reduce Motion on or off never plays an entrance again: it has the same name under both settings", () => {
    // An animation whose name changes starts afresh (both engines, measured 2026-10-31), so a card that came in an hour
    // ago would drop in again. Exits are exempt (no copy is made under Reduce Motion), as is `.m-arrive`, which
    // ChatScreen.tsx takes off a second after it puts it on.
    const own = (d: Decl) => /^styles\/motion(-\w+)?\.css$/.test(d.file);
    const exempt = (selector: string) => selector.includes("[data-ghost") || selector.includes(".m-arrive");
    const byName = (setting: Setting) => {
      const out = new Map<string, string>();
      for (const d of animations.filter((d) => own(d) && settingsOf(d).includes(setting))) {
        for (const s of selectors(d)) if (!exempt(s)) out.set(s, [...new Set(playedOnce(d))].sort().join(" "));
      }
      return out;
    };
    const motion = byName("motion");
    const reduce = byName("reduce");
    expect(motion.size).toBeGreaterThan(10);
    for (const s of new Set([...motion.keys(), ...reduce.keys()])) expect(reduce.get(s) ?? "", `${s}: with motion "${motion.get(s) ?? ""}"`).toBe(motion.get(s) ?? "");
  });

  test("a setting's own keyframes are in the file that defines them for both, after them (so they win)", () => {
    // The last definition that applies wins, and motion.css's own rules come after the files it imports: a setting's
    // version anywhere but after the shared one, in its file, could lose to it.
    for (const [name, all] of KEYFRAMES) {
      const both = all.filter((k) => settingOf(k.media) === null);
      expect(both.length, `@keyframes ${name} is defined for both settings once`).toBeLessThanOrEqual(1);
      for (const s of SETTINGS) expect(all.filter((k) => settingOf(k.media) === s).length, `@keyframes ${name} with ${s}`).toBeLessThanOrEqual(1);
      if (!both.length) continue;
      for (const k of all.filter((k) => settingOf(k.media) !== null)) {
        expect(k.file, `@keyframes ${name} with ${settingOf(k.media)}`).toBe(both[0].file);
        expect(k.order, `@keyframes ${name} with ${settingOf(k.media)} comes after the shared one`).toBeGreaterThan(both[0].order);
      }
    }
  });
});

describe("nothing is in place later than it was in 0.6.2", () => {
  /** What 0.6.2 already moved in, and by when it was in place there. */
  const BEFORE: [string, number][] = [
    [".app.mobile .dialog", 220],
    [".chat-sidebar.drawer", 200],
    [".toast", 180],
    [".ctl-pop", 120],
  ];
  test("with motion, a sheet, the drawer, a notice and the chat's menus move no longer than they did", () => {
    for (const [selector, ms] of BEFORE) {
      const found = animations.filter((d) => settingOf(d.media) === "motion" && selectors(d).includes(selector));
      expect(found.length, selector).toBeGreaterThan(0);
      for (const d of found) for (const t of durations(d.value)) expect(t, where(d)).toBeLessThanOrEqual(ms);
    }
  });
});

describe("a finger leaves no hover behind", () => {
  test("every :hover rule is for pointers that hover (@media (hover: hover)): on a phone, a tap leaves :hover on", () => {
    const bare = DECLS.filter((d) => /:hover\b/.test(d.selector) && !d.media.some((m) => /\(\s*hover\s*:\s*hover\s*\)/.test(m)));
    expect([...new Set(bare.map((d) => `${d.file}: ${d.selector}`))]).toEqual([]);
  });
});

describe("nothing waits for an animation", () => {
  test("no source file listens for an animation or a transition to end", () => {
    const found: string[] = [];
    const walk = (dir: string) => {
      for (const e of readdirSync(dir, { withFileTypes: true })) {
        const path = join(dir, e.name);
        if (e.isDirectory()) walk(path);
        else if (/\.tsx?$/.test(e.name) && !/\.test\.tsx?$/.test(e.name)) {
          // Code only: a comment may say what never to do.
          const text = readFileSync(path, "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`])\/\/.*$/gm, "$1");
          if (/animationend|transitionend|animationcancel|transitioncancel|onAnimationEnd|onTransitionEnd/.test(text)) found.push(relative(SRC, path));
        }
      }
    };
    walk(SRC);
    expect(found).toEqual([]);
  });
});

describe("a chat's entrances count from when it last went quiet (motion.ts useQuietSince)", () => {
  test("never while a batch is on its way, and once it's in, the moment it went quiet: the same on every redraw after", () => {
    // The same number on every redraw is what keeps a chat's EntranceScope from drawing its replies again while it
    // catches up: it was a new one on each (performance.now() while busy).
    const redraws: [busy: boolean, at: number][] = [[true, 10], [true, 20], [false, 30], [false, 40], [false, 900], [true, 950], [true, 990], [false, 1000], [false, 1400]];
    const seen: (number | null)[] = [];
    let q: number | null = null;
    for (const [busy, at] of redraws) seen.push((q = quietSince(q, busy, at)));
    expect(seen).toEqual([null, null, 30, 30, 30, null, null, 1000, 1000]);
  });
});

test("durations read as milliseconds", () => {
  expect(toMs("150ms")).toBe(150);
  expect(toMs(" 0.15s ")).toBe(150);
  expect(toMs("1100ms")).toBe(1100);
  expect(toMs("")).toBe(0);
  expect(toMs("ease")).toBe(0);
});
