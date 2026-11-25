import { useSyncExternalStore } from "react";
import { DEFAULT_SETTINGS, deserialize, isPristine, luminance, paintFor, serialize, TEXTURE_ATTR, textureAttr, THEME_KEY, toHex, type Paint, type PictureInfo, type ThemeSettings } from "./theme";

/**
 * The theme on this device (theme.ts works out what it paints): kept in localStorage with what it paints, so
 * index.html can paint the page before the app loads; applied here as CSS variables and attributes on the page's root;
 * and its picture, which is too big for localStorage, kept in IndexedDB and shown a moment after the page (over its own
 * average colour, so nothing flashes). The texture (Flat, Skeuomorphic, Liquid glass) is kept with it and is one
 * attribute on the root, which index.html also sets before the first paint. Nothing is sent to a machine: another
 * device has its own theme.
 */

/** The background picture is never kept bigger than this on its long side. */
export const PICTURE_LONG_SIDE = 2560;

const DB = "crosstalk-theme";
const STORE = "picture";
const PICTURE = "background";
/** The page's own bar colour (index.html), for the look styles.css draws by itself. */
const DEFAULT_BAR = "#000000";

let settings: ThemeSettings = DEFAULT_SETTINGS;
let applied: Paint | null = null;
let pictureUrl: string | null = null;
/** Counts the picture's changes, so a slow read can't put back one that has been replaced. */
let pictureTurn = 0;
const listeners = new Set<() => void>();
const tell = () => {
  for (const fn of listeners) fn();
};

const lessGlass = () => typeof matchMedia === "function" && matchMedia("(prefers-reduced-transparency: reduce)").matches;

function stored(): { settings: ThemeSettings; paint: Paint | null } {
  try {
    const text = localStorage.getItem(THEME_KEY);
    if (!text) return { settings: DEFAULT_SETTINGS, paint: null };
    const paint = (JSON.parse(text) as { paint?: Paint | null }).paint;
    return { settings: deserialize(text), paint: paint && typeof paint === "object" && paint.vars && paint.attrs ? paint : null };
  } catch {
    return { settings: DEFAULT_SETTINGS, paint: null };
  }
}

function setMeta(name: string, content: string) {
  document.querySelector(`meta[name="${name}"]`)?.setAttribute("content", content);
}

/** Puts a look on the page: what the last one set and this one doesn't is taken off, so nothing of it lingers. */
function apply(paint: Paint | null) {
  const root = document.documentElement;
  for (const k of Object.keys(applied?.vars ?? {})) if (!paint || !(k in paint.vars)) root.style.removeProperty(k);
  for (const k of Object.keys(applied?.attrs ?? {})) if (!paint || !(k in paint.attrs)) root.removeAttribute(k);
  if (paint) {
    for (const [k, v] of Object.entries(paint.vars)) if (root.style.getPropertyValue(k) !== v) root.style.setProperty(k, v);
    for (const [k, v] of Object.entries(paint.attrs)) if (root.getAttribute(k) !== v) root.setAttribute(k, v);
  }
  // The texture: one attribute, whatever the theme (OLED black paints nothing and still takes one). None for Flat.
  const texture = textureAttr(settings);
  if (!texture) root.removeAttribute(TEXTURE_ATTR);
  else if (root.getAttribute(TEXTURE_ATTR) !== texture) root.setAttribute(TEXTURE_ATTR, texture);
  // The browser's bar and, for an app on the Home Screen, the status bar's words.
  setMeta("theme-color", paint?.color ?? DEFAULT_BAR);
  setMeta("apple-mobile-web-app-status-bar-style", paint?.scheme === "light" ? "default" : "black");
  applied = paint;
  measureBackdrop();
  showPicture();
}

const wantsPicture = () => applied?.attrs["data-backdrop"] === "picture";

/** The picture goes on the page once it's read and decoded, and comes off when the theme has none. */
function showPicture() {
  const root = document.documentElement;
  if (wantsPicture() && pictureUrl) {
    root.style.setProperty("--backdrop-picture", `url("${pictureUrl}")`);
    root.setAttribute("data-picture", "ready");
  } else {
    root.style.removeProperty("--backdrop-picture");
    root.removeAttribute("data-picture");
  }
}

function save() {
  try {
    if (isPristine(settings)) localStorage.removeItem(THEME_KEY);
    else localStorage.setItem(THEME_KEY, serialize(settings, applied));
  } catch {
    // Kept for this visit only.
  }
}

// ------------------------------------------------------------ the picture, in IndexedDB

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error("This browser wouldn't open its storage."));
  });
}

async function inStore<T>(mode: IDBTransactionMode, run: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const db = await openDb();
  try {
    return await new Promise<T>((resolve, reject) => {
      const tx = db.transaction(STORE, mode);
      const req = run(tx.objectStore(STORE));
      tx.oncomplete = () => resolve(req.result);
      tx.onerror = tx.onabort = () => reject(tx.error ?? req.error ?? new Error("This browser wouldn't keep the picture."));
    });
  } finally {
    db.close();
  }
}

/**
 * The picture as it's kept: its bytes and what kind of picture they are. (Not a Blob: Safari's private windows refuse
 * to keep one in IndexedDB.)
 */
type KeptPicture = { bytes: ArrayBuffer; type: string };

/** Shows the saved picture, when there is one (read once; choosing or removing one replaces it). */
async function loadPicture() {
  if (pictureUrl || !settings.custom.picture.average) return;
  const turn = pictureTurn;
  try {
    const kept = await inStore<KeptPicture | Blob | undefined>("readonly", (s) => s.get(PICTURE));
    if (!kept || turn !== pictureTurn) return;
    await usePicture(kept instanceof Blob ? kept : new Blob([kept.bytes], { type: kept.type }), turn);
  } catch {
    // No picture to show: its average colour stays.
  }
}

async function usePicture(blob: Blob, turn: number) {
  const url = URL.createObjectURL(blob);
  // Decoded first, so it fades in whole rather than drawing in strips.
  const img = new Image();
  img.src = url;
  await img.decode().catch(() => {});
  if (turn !== pictureTurn) return URL.revokeObjectURL(url);
  if (pictureUrl) URL.revokeObjectURL(pictureUrl);
  pictureUrl = url;
  showPicture();
  tell();
}

type Drawable = ImageBitmap | HTMLImageElement;

async function decode(file: Blob): Promise<Drawable> {
  if (typeof createImageBitmap === "function") {
    try {
      // Turned the way the camera held it.
      return await createImageBitmap(file, { imageOrientation: "from-image" });
    } catch {
      // An engine that can't (some can't read an SVG this way): as an <img>, below.
    }
  }
  const url = URL.createObjectURL(file);
  try {
    const img = new Image();
    img.src = url;
    await img.decode();
    return img;
  } finally {
    URL.revokeObjectURL(url);
  }
}

const sizeOf = (d: Drawable) => ("naturalWidth" in d ? { w: d.naturalWidth, h: d.naturalHeight } : { w: d.width, h: d.height });

function draw(d: Drawable, w: number, h: number): HTMLCanvasElement {
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("This browser couldn't read the picture.");
  // A see-through picture sits on black.
  ctx.fillStyle = "#000";
  ctx.fillRect(0, 0, w, h);
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(d, 0, 0, w, h);
  return canvas;
}

/** A picture's colour on the whole, and how dark and how bright it gets (its 5th and 95th percentile luminance). */
export function pictureStats(pixels: Uint8ClampedArray): { average: string; lo: number; hi: number } {
  let r = 0;
  let g = 0;
  let b = 0;
  const lums: number[] = [];
  for (let i = 0; i + 3 < pixels.length; i += 4) {
    r += pixels[i];
    g += pixels[i + 1];
    b += pixels[i + 2];
    lums.push(luminance({ r: pixels[i], g: pixels[i + 1], b: pixels[i + 2] }));
  }
  const n = Math.max(1, lums.length);
  lums.sort((x, y) => x - y);
  const at = (p: number) => lums[Math.min(lums.length - 1, Math.floor(p * lums.length))] ?? 0;
  const round = (v: number) => Math.round(v * 1000) / 1000;
  return { average: toHex({ r: r / n, g: g / n, b: b / n }), lo: round(at(0.05)), hi: round(at(0.95)) };
}

/**
 * Makes `file` the background picture: made smaller here in the browser (never over PICTURE_LONG_SIDE on its long
 * side), kept on this device, and shown. Throws, in plain words, when it isn't a picture or can't be kept.
 */
export async function choosePicture(file: Blob): Promise<void> {
  let source: Drawable;
  try {
    source = await decode(file);
  } catch {
    throw new Error("That file isn't a picture this browser can show. Try a JPEG or a PNG.");
  }
  const { w, h } = sizeOf(source);
  if (!w || !h) throw new Error("That picture is empty.");
  const scale = Math.min(1, PICTURE_LONG_SIDE / Math.max(w, h));
  const canvas = draw(source, Math.max(1, Math.round(w * scale)), Math.max(1, Math.round(h * scale)));
  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/jpeg", 0.86));
  if (!blob) throw new Error("This browser couldn't make the picture smaller.");
  const small = draw(source, 32, 32).getContext("2d")!.getImageData(0, 0, 32, 32).data;
  if ("close" in source) source.close();
  const stats = pictureStats(small);
  try {
    const kept: KeptPicture = { bytes: await blob.arrayBuffer(), type: blob.type };
    await inStore("readwrite", (s) => s.put(kept, PICTURE));
  } catch {
    throw new Error("This device has no room to keep the picture. Free some space, or choose a smaller one.");
  }
  const turn = ++pictureTurn;
  const picture: PictureInfo = { ...settings.custom.picture, ...stats };
  setTheme({ ...settings, custom: { ...settings.custom, base: "picture", picture } });
  await usePicture(blob, turn);
}

/** Takes the background picture off this device. Its blur and dim stay for the next one. */
export async function removePicture(): Promise<void> {
  pictureTurn++;
  if (pictureUrl) URL.revokeObjectURL(pictureUrl);
  pictureUrl = null;
  setTheme({ ...settings, custom: { ...settings.custom, picture: { ...settings.custom.picture, average: null } } });
  tell();
  await inStore("readwrite", (s) => s.delete(PICTURE)).catch(() => {});
}

// ------------------------------------------------------------ the theme

/** Changes the theme on this device, at once, and keeps it. */
export function setTheme(next: ThemeSettings) {
  settings = next;
  apply(paintFor(settings, lessGlass()));
  save();
  if (wantsPicture()) void loadPicture();
  tell();
}

/** Back to how the app comes: the default look, nothing of your own kept, no picture on the device. */
export async function resetTheme(): Promise<void> {
  pictureTurn++;
  if (pictureUrl) URL.revokeObjectURL(pictureUrl);
  pictureUrl = null;
  setTheme(DEFAULT_SETTINGS);
  await inStore("readwrite", (s) => s.delete(PICTURE)).catch(() => {});
}

/**
 * The backdrop keeps its size while the on-screen keyboard is up: it's as tall as the screen has been at this width,
 * so a picture doesn't jump or rescale each time the keyboard comes and goes. Only a theme with a backdrop sets it.
 */
const backdropHeight = { width: 0, tallest: 0 };
function measureBackdrop() {
  const root = document.documentElement;
  if (!applied?.attrs["data-backdrop"]) return void root.style.removeProperty("--backdrop-height");
  if (window.innerWidth !== backdropHeight.width) {
    backdropHeight.width = window.innerWidth;
    backdropHeight.tallest = 0;
  }
  backdropHeight.tallest = Math.max(backdropHeight.tallest, window.innerHeight);
  const height = `${backdropHeight.tallest}px`;
  if (root.style.getPropertyValue("--backdrop-height") !== height) root.style.setProperty("--backdrop-height", height);
}

/** Applies the theme saved on this device. index.html has painted it already; this takes over from there. */
export function initTheme() {
  const was = stored();
  settings = was.settings;
  // What index.html put on the page, so anything today's theme no longer sets comes off.
  applied = was.paint;
  const paint = paintFor(settings, lessGlass());
  apply(paint);
  // A newer app works a look out differently: what's kept is brought up to date, for the next start.
  if (JSON.stringify(paint) !== JSON.stringify(was.paint)) save();
  window.addEventListener("resize", measureBackdrop);
  if (wantsPicture()) void loadPicture();
  // Another tab of the app changed it.
  window.addEventListener("storage", (e) => {
    if (e.key !== THEME_KEY && e.key !== null) return;
    const now = stored().settings;
    const samePicture = now.custom.picture.average === settings.custom.picture.average;
    settings = now;
    if (!samePicture) {
      pictureTurn++;
      if (pictureUrl) URL.revokeObjectURL(pictureUrl);
      pictureUrl = null;
    }
    apply(paintFor(settings, lessGlass()));
    if (wantsPicture()) void loadPicture();
    tell();
  });
  // The device's own "Reduce transparency" turned on or off.
  if (typeof matchMedia === "function") matchMedia("(prefers-reduced-transparency: reduce)").addEventListener?.("change", () => setTheme(settings));
}

const subscribe = (fn: () => void) => {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
};

/** The theme chosen on this device. */
export function useTheme(): ThemeSettings {
  return useSyncExternalStore(subscribe, () => settings);
}

/** The background picture's address on this device (null: none, or not read yet). Reads it when first asked. */
export function usePictureUrl(): string | null {
  const url = useSyncExternalStore(subscribe, () => pictureUrl);
  if (!url && settings.custom.picture.average) void loadPicture();
  return url;
}

/** Whether the device itself asks for less see-through (its own setting wins over the switch being off). */
export function useDeviceLessGlass(): boolean {
  return useSyncExternalStore(
    (fn) => {
      if (typeof matchMedia !== "function") return () => {};
      const q = matchMedia("(prefers-reduced-transparency: reduce)");
      q.addEventListener?.("change", fn);
      return () => q.removeEventListener?.("change", fn);
    },
    lessGlass,
  );
}

/** What the page's terminal is drawn with (Terminal.tsx): the theme's own colours, read off the page. */
export function terminalColors(): { background: string; foreground: string; cursor: string; selectionBackground: string; themed: boolean } {
  const css = getComputedStyle(document.documentElement);
  const read = (name: string, fallback: string) => css.getPropertyValue(name).trim() || fallback;
  const accent = read("--accent", "#3d95ff");
  return { background: read("--term-screen", "#000000"), foreground: read("--term-text", "#e8e8ea"), cursor: accent, selectionBackground: /^#[0-9a-f]{6}$/i.test(accent) ? `${accent}55` : "#3d95ff55", themed: !!applied?.attrs["data-theme"] };
}

/** Calls `fn` whenever the theme changes; returns how to stop. */
export const onTheme = subscribe;
