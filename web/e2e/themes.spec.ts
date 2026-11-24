import type { APIRequestContext, Page } from "@playwright/test";
import type { Member, Message, Room } from "@crosstalk/shared";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { test, expect, noHorizontalOverflow } from "./fixtures";
import { pong } from "./otherMachine";
import { CUSTOM_THEME, DEFAULT_CUSTOM, DEFAULT_SETTINGS, paintFor, PRESETS, serialize, THEME_KEY, type CustomTheme, type ThemeSettings } from "../src/theme";

// Themes (Settings → This device → Theme): the presets, your own colour, gradient and picture, and that words stay
// readable on whatever a theme puts behind them.
// CT_SHOTS: a folder to save every theme's screens in, to look at them.

const HUB = "http://127.0.0.1:8451";

/** The theme a device would have saved, put there before the app loads (what picking it in Settings leaves behind). */
async function saved(page: Page, settings: ThemeSettings) {
  // Once: what the test then changes in Settings is still there after a reload.
  await page.addInitScript(([key, value]) => {
    if (sessionStorage.getItem("ct-theme-saved")) return;
    sessionStorage.setItem("ct-theme-saved", "1");
    localStorage.setItem(key, value);
  }, [THEME_KEY, serialize(settings, paintFor(settings))] as const);
}
/** A quick double tap doesn't count as a two-step button's second step. */
const pastDoubleTap = (page: Page) => page.waitForTimeout(450);
const preset = (id: string): ThemeSettings => ({ ...DEFAULT_SETTINGS, theme: id });
const custom = (c: Partial<CustomTheme>): ThemeSettings => ({ ...DEFAULT_SETTINGS, theme: CUSTOM_THEME, custom: { ...DEFAULT_CUSTOM, ...c } });

async function openTheme(page: Page) {
  await page.goto("/#/settings/appearance");
  const tiles = page.getByRole("radiogroup", { name: "Theme", exact: true });
  await expect(tiles).toBeVisible();
  return tiles;
}
const tile = (page: Page, name: string) => page.getByRole("radiogroup", { name: "Theme", exact: true }).getByRole("radio", { name: new RegExp(`^${name}\\.`) });

/** What the page's root says about the theme in use. */
const root = (page: Page) =>
  page.evaluate(() => {
    const el = document.documentElement;
    const css = getComputedStyle(el);
    const v = (name: string) => css.getPropertyValue(name).trim();
    return {
      theme: el.getAttribute("data-theme"),
      scheme: el.getAttribute("data-scheme"),
      backdrop: el.getAttribute("data-backdrop"),
      glass: el.getAttribute("data-glass"),
      picture: el.getAttribute("data-picture"),
      inline: el.getAttribute("style") ?? "",
      bg: v("--bg"),
      accent: v("--accent"),
      surface: v("--surface"),
      backdropCss: v("--backdrop"),
      blur: v("--backdrop-blur"),
      size: v("--backdrop-size"),
      filter: v("--glass-filter"),
      radius: v("--radius-lg"),
      page: getComputedStyle(document.body).backgroundColor,
      colorScheme: css.colorScheme,
      bar: document.querySelector('meta[name="theme-color"]')?.getAttribute("content"),
      stored: localStorage.getItem("crosstalk.theme.v1"),
    };
  });

/** A real chat whose history the test writes (its agent never runs): a question, a reply with a list, code and a link, and a follow-up. */
async function chatWithMessages(page: Page, request: APIRequestContext, token: string) {
  const headers = { authorization: `Bearer ${token}` };
  const room: Room = await (await request.post(`${HUB}/api/chats`, { headers, data: { provider: "claude", name: "Theme check" } })).json();
  const snapshot = await (await request.get(`${HUB}/api/state`, { headers })).json();
  const member: Member = snapshot.members.find((m: Member) => m.roomId === room.id);
  let seq = 0;
  const message = (kind: "human" | "agent", text: string): Message =>
    ({ id: `th-${++seq}`, seq, roomId: room.id, authorKind: kind, authorName: kind === "human" ? "Phone" : member.handle, memberId: kind === "agent" ? member.id : null, text, mentions: [], turnId: null, status: "done", createdAt: Date.now() - 60_000 + seq * 1000, updatedAt: Date.now() - 60_000 + seq * 1000 }) as Message;
  const messages = [
    message("human", "Can you add a `--dry-run` flag to the sync script?"),
    message(
      "agent",
      "Done. The flag is read in `parseArgs` and nothing is written when it's set.\n\n- `sync.ts` checks it before every write\n- the tests cover both ways\n\n```ts\nexport function sync(opts: { dryRun: boolean }) {\n  if (opts.dryRun) return plan(); // nothing touches the disk\n  return apply(plan());\n}\n```\n\nThe [changelog](https://example.com/changelog) has a line for it.",
    ),
    message("human", "Nice. Run the tests once more and tell me what `plan()` prints."),
    message("agent", "All 42 tests pass. `plan()` prints one line per file it would copy, and a total at the end."),
  ];
  const history = { room, messages, turns: [], activities: [], approvals: [], tasks: {}, totals: null, hasMore: false };
  await page.routeWebSocket("**/api/ws?**", (ws) => pong(ws));
  await page.route("**/api/state", (r) => r.fulfill({ json: { ...snapshot, members: snapshot.members.map((m: Member) => (m.id === member.id ? { ...m, status: "idle", readSeq: seq } : m)) } }));
  await page.route(`**/api/rooms/${room.id}/history**`, (r) => r.fulfill({ json: history }));
  return {
    room,
    open: async () => {
      await page.goto(`/#/room/${room.id}`);
      await expect(page.getByRole("textbox", { name: "Message", exact: true })).toBeVisible();
      await expect(page.locator(".md pre").first()).toBeVisible();
    },
    cleanup: () => request.delete(`${HUB}/api/rooms/${room.id}`, { headers }),
  };
}

type Reading = { text: string; where: string; ratio: number };

/**
 * How well every piece of text on screen reads against what is really painted behind it. The page is photographed
 * with its words made invisible, so each pixel behind a word is what the theme put there (a gradient, a picture, a
 * see-through panel over them, a blur); each word's own colour, faded by whatever fades it, is then compared with the
 * pixels under it, and the worst one counts. Left out: what's switched off (dimmed on purpose), and marks drawn in
 * white on an agent's or a status colour, which no theme changes.
 */
async function readings(page: Page): Promise<Reading[]> {
  // First each word's own colour and place, while the page is as a person sees it (a control's colour takes a moment
  // to change with the theme: once that's done).
  await page.evaluate(async () => {
    await Promise.race([Promise.all(document.getAnimations().filter((a) => a instanceof CSSTransition).map((a) => a.finished.catch(() => {}))), new Promise((done) => setTimeout(done, 600))]);
    const probe = document.createElement("canvas").getContext("2d", { willReadFrequently: true })!;
    const rgba = (color: string) => {
      probe.clearRect(0, 0, 1, 1);
      probe.fillStyle = "#000";
      probe.fillStyle = color;
      probe.fillRect(0, 0, 1, 1);
      const d = probe.getImageData(0, 0, 1, 1).data;
      return { r: d[0], g: d[1], b: d[2], a: d[3] / 255 };
    };
    const skip = ".avatar, .room-avatar, .count, .sidebar-count, .tp, .theme-swatch, .theme-start i, .btn.danger.solid, .helpers-stop.ask, .xterm, [aria-hidden='true'], .settings-elsewhere";
    const found: { text: string; where: string; color: { r: number; g: number; b: number; a: number }; boxes: number[][] }[] = [];
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const words = node.textContent?.trim() ?? "";
      const el = node.parentElement;
      if (!words || !el || el.closest(skip) || el.closest(":disabled, [aria-disabled='true']")) continue;
      const style = getComputedStyle(el);
      if (style.visibility === "hidden" || style.display === "none") continue;
      const color = rgba(style.color);
      let opacity = 1;
      for (let up: Element | null = el; up; up = up.parentElement) opacity *= Number(getComputedStyle(up).opacity);
      color.a *= opacity;
      if (color.a < 0.05) continue;
      const range = document.createRange();
      range.selectNodeContents(node);
      const boxes: number[][] = [];
      for (const r of range.getClientRects()) {
        // Only what's on screen and really this element's (not scrolled under a bar or clipped away).
        const x0 = Math.max(0, Math.ceil(r.left) + 1);
        const x1 = Math.min(window.innerWidth - 1, Math.floor(r.right) - 1);
        const y0 = Math.max(0, Math.ceil(r.top) + 1);
        const y1 = Math.min(window.innerHeight - 1, Math.floor(r.bottom) - 1);
        if (x1 <= x0 || y1 <= y0) continue;
        const at = document.elementFromPoint((x0 + x1) / 2, (y0 + y1) / 2);
        if (!at || !(at === el || el.contains(at) || at.contains(el))) continue;
        boxes.push([x0, y0, x1, y1]);
      }
      if (!boxes.length) continue;
      const where = [el.closest("[class]")?.getAttribute("class")?.split(" ")[0] ?? el.tagName.toLowerCase(), el.parentElement?.closest("[class]")?.getAttribute("class")?.split(" ")[0] ?? ""].filter(Boolean).join(" < ");
      found.push({ text: words.slice(0, 40), where, color, boxes });
    }
    (window as unknown as { ctWords: typeof found }).ctWords = found;
  });
  // Then the page with its words invisible (at once: a colour that fades would be caught halfway).
  const hide = await page.addStyleTag({
    content: "*, *::before, *::after, ::placeholder { color: transparent !important; -webkit-text-fill-color: transparent !important; text-shadow: none !important; caret-color: transparent !important; transition: none !important; } svg, img, canvas { visibility: hidden !important; }",
  });
  const png = (await page.screenshot({ animations: "disabled" })).toString("base64");
  await hide.evaluate((el) => el.remove());
  return page.evaluate(async (png) => {
    const blob = await (await fetch(`data:image/png;base64,${png}`)).blob();
    const bitmap = await createImageBitmap(blob);
    const canvas = document.createElement("canvas");
    canvas.width = bitmap.width;
    canvas.height = bitmap.height;
    const ctx = canvas.getContext("2d", { willReadFrequently: true })!;
    ctx.drawImage(bitmap, 0, 0);
    const shot = ctx.getImageData(0, 0, canvas.width, canvas.height);
    const scale = canvas.width / window.innerWidth;
    const lin = (v: number) => (v / 255 <= 0.04045 ? v / 255 / 12.92 : ((v / 255 + 0.055) / 1.055) ** 2.4);
    const lum = (c: { r: number; g: number; b: number }) => 0.2126 * lin(c.r) + 0.7152 * lin(c.g) + 0.0722 * lin(c.b);
    const words = (window as unknown as { ctWords: { text: string; where: string; color: { r: number; g: number; b: number; a: number }; boxes: number[][] }[] }).ctWords;
    return words.map(({ text, where, color, boxes }) => {
      let worst = Infinity;
      for (const [x0, y0, x1, y1] of boxes) {
        for (let y = y0; y <= y1; y += 2) {
          for (let x = x0; x <= x1; x += 3) {
            const i = (Math.round(y * scale) * shot.width + Math.round(x * scale)) * 4;
            const under = { r: shot.data[i], g: shot.data[i + 1], b: shot.data[i + 2] };
            const ink = { r: under.r + (color.r - under.r) * color.a, g: under.g + (color.g - under.g) * color.a, b: under.b + (color.b - under.b) * color.a };
            const [hi, lo] = [lum(ink), lum(under)].sort((p, q) => q - p);
            worst = Math.min(worst, (hi + 0.05) / (lo + 0.05));
          }
        }
      }
      return { text, where, ratio: Math.round(worst * 100) / 100 };
    });
  }, png);
}

/** Every piece of text reads at 4.5:1 or better: the ones that don't are named, with what they're on. */
async function expectReadable(page: Page, what: string, allow: (r: Reading) => boolean = () => false) {
  const all = await readings(page);
  expect(all.length, `${what}: there are words to measure`).toBeGreaterThan(8);
  const poor = all.filter((r) => r.ratio < 4.5 && !allow(r)).map((r) => `${r.ratio} "${r.text}" (${r.where})`);
  expect(poor, `${what}: words that read below 4.5:1`).toEqual([]);
}

test("a device that never chose a theme has OLED black, and nothing of a theme is on the page", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator(".topbar h1")).toBeVisible();
  const r = await root(page);
  expect([r.theme, r.scheme, r.backdrop, r.glass, r.picture]).toEqual([null, null, null, null, null]);
  // No variable of a theme on the root: styles.css draws everything as it always did.
  for (const name of ["--bg", "--surface", "--text", "--accent", "--sep", "--backdrop", "--radius", "--primary"]) expect(r.inline, name).not.toContain(name);
  expect([r.bg, r.accent, r.surface, r.page, r.bar, r.stored]).toEqual(["#000000", "#3d95ff", "#111113", "rgb(0, 0, 0)", "#000000", null]);
  expect(r.colorScheme).toBe("dark");
  expect(await page.evaluate(() => getComputedStyle(document.body, "::before").content)).toBe("none");
  // In Settings it's the one that's picked, and looking at the section saves nothing.
  await openTheme(page);
  await expect(tile(page, "OLED black")).toHaveAttribute("aria-checked", "true");
  await expect(page.getByRole("region", { name: "Your own theme", exact: true })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Reset theme", exact: true })).toBeDisabled();
  expect((await root(page)).stored).toBeNull();
});

test("a tap on a preset changes the look at once, and it's there before the app loads after a reload", async ({ page }) => {
  await openTheme(page);
  // Every preset is a tile, and each one changes the page as it's tapped.
  for (const p of PRESETS) {
    await tile(page, p.name).click();
    await expect(tile(page, p.name)).toHaveAttribute("aria-checked", "true");
    const r = await root(page);
    const paint = paintFor(preset(p.id));
    expect(r.theme, p.name).toBe(paint ? p.id : null);
    expect(r.bg, p.name).toBe(paint ? paint.vars["--bg"] : "#000000");
    expect(r.bar, p.name).toBe(paint ? paint.color : "#000000");
    expect(r.colorScheme, p.name).toBe(paint?.scheme ?? "dark");
    expect(r.backdrop, p.name).toBe(paint?.attrs["data-backdrop"] ?? null);
  }
  await tile(page, "Midnight").click();
  const midnight = paintFor(preset("midnight"))!;
  expect((await root(page)).page).not.toBe("rgb(0, 0, 0)");
  await noHorizontalOverflow(page);

  // The app's own code is held back: what's on the page now is what index.html alone painted from what was saved.
  await page.route("**/src/main.tsx*", (r) => r.abort());
  await page.reload();
  await expect.poll(() => page.evaluate(() => document.readyState)).not.toBe("loading");
  const before = await root(page);
  expect(before.theme).toBe("midnight");
  expect(before.bg).toBe(midnight.vars["--bg"]);
  expect(before.accent).toBe(midnight.vars["--accent"]);
  expect(before.bar).toBe(midnight.color);
  expect(await page.locator("#root").innerHTML()).toBe("");

  // And with the app: the same look, the same tile picked.
  await page.unroute("**/src/main.tsx*");
  await page.reload();
  await expect(tile(page, "Midnight")).toHaveAttribute("aria-checked", "true");
  expect((await root(page)).bg).toBe(midnight.vars["--bg"]);

  // Back to OLED black by its tile: nothing of the theme stays on the page.
  await tile(page, "OLED black").click();
  const after = await root(page);
  expect([after.theme, after.scheme, after.bg, after.page, after.bar]).toEqual([null, null, "#000000", "rgb(0, 0, 0)", "#000000"]);
  for (const name of ["--bg", "--surface", "--text", "--accent", "--backdrop"]) expect(after.inline, name).not.toContain(name);
  expect(after.stored).toBeNull();
});

for (const p of PRESETS) {
  test(`${p.name}: words read on what's behind them, in a chat and in Settings`, async ({ page, request, token }) => {
    test.setTimeout(60_000);
    await saved(page, preset(p.id));
    const chat = await chatWithMessages(page, request, token);
    try {
      await chat.open();
      expect((await root(page)).theme).toBe(p.spec ? p.id : null);
      // OLED black's own smallest words are under 4.5:1 in two places, as they were before themes (it isn't changed
      // here): a code block's header ("ts", "4 lines": 4.2:1) and the open chat's second line in the docked list, on
      // its agent's tint (3.8:1). Every theme is held to 4.5:1 there too.
      await expectReadable(page, `${p.name}, a chat`, (r) => !p.spec && ((r.where.includes("codeblock-head") && r.ratio >= 4.1) || (r.where.includes("csb-chat-sub") && r.ratio >= 3.7)));
      await noHorizontalOverflow(page);
      await openTheme(page);
      await expectReadable(page, `${p.name}, Settings`);
      await noHorizontalOverflow(page);
      await page.goto("/#/");
      await expect(page.getByRole("heading", { name: "What agent do you want to use?", exact: true })).toBeVisible();
      await expectReadable(page, `${p.name}, Home`);
    } finally {
      await chat.cleanup();
    }
  });
}

test("your own colours: an accent and a background, with everything else worked out to read on them", async ({ page }) => {
  const tiles = await openTheme(page);
  await tile(page, "Your own").click();
  const editor = page.getByRole("region", { name: "Your own theme", exact: true });
  await expect(editor).toBeVisible();
  expect((await root(page)).theme).toBe("custom");

  // A swatch, then any colour from the picker: the page follows each.
  await editor.getByRole("button", { name: "Accent colour #ff6fb5", exact: true }).click();
  expect((await root(page)).accent).toBe("#ff6fb5");
  await editor.getByLabel("Background colour: any colour", { exact: true }).fill("#f2e9d0");
  let r = await root(page);
  expect(r.bg).toBe("#f2e9d0");
  expect(r.scheme).toBe("light");
  // Pink wouldn't read on cream: it's the same hue, made darker.
  expect(r.accent).not.toBe("#ff6fb5");
  await expectReadable(page, "pink on cream");

  // A grey in the middle, the hardest page colour there is, and words asked to be light on it: still readable.
  await editor.getByLabel("Background colour: any colour", { exact: true }).fill("#808080");
  await editor.getByRole("radiogroup", { name: "Words", exact: true }).getByRole("radio", { name: "Light", exact: true }).click();
  expect((await root(page)).scheme).toBe("dark");
  await expectReadable(page, "light words on grey");
  await editor.getByRole("radiogroup", { name: "Words", exact: true }).getByRole("radio", { name: "Dark", exact: true }).click();
  expect((await root(page)).scheme).toBe("light");
  await expectReadable(page, "dark words on grey");

  // Corners move with the slider, by the keyboard too.
  const corners = editor.getByRole("slider", { name: "Corners", exact: true });
  const was = (await root(page)).radius;
  await corners.focus();
  await page.keyboard.press("End");
  await expect(corners).toHaveValue("100");
  expect((await root(page)).radius).toBe("28px");
  expect(was).not.toBe("28px");
  await noHorizontalOverflow(page);

  // A preset and back: your own theme is as you left it.
  await tile(page, "Light").click();
  await expect(editor).toHaveCount(0);
  await tile(page, "Your own").click();
  await expect(editor.getByLabel("Background colour: any colour", { exact: true })).toHaveValue("#808080");
  await expect(corners).toHaveValue("100");
  await page.reload();
  await expect(tiles.getByRole("radio", { name: /^Your own\./ })).toHaveAttribute("aria-checked", "true");
  r = await root(page);
  expect([r.theme, r.radius]).toEqual(["custom", "28px"]);
});

test("your own gradient: colours, direction and shape, and panels from glass to solid", async ({ page }) => {
  await openTheme(page);
  await tile(page, "Your own").click();
  const editor = page.getByRole("region", { name: "Your own theme", exact: true });
  await editor.getByRole("radiogroup", { name: "Background", exact: true }).getByRole("radio", { name: "Gradient", exact: true }).click();
  let r = await root(page);
  expect(r.backdrop).toBe("gradient");
  expect(r.backdropCss).toContain("linear-gradient(160deg, #1a1040, #5b1a5e, #9c2f45)");
  // One fixed layer behind the app paints it.
  const layer = await page.evaluate(() => {
    const s = getComputedStyle(document.body, "::before");
    return { position: s.position, image: s.backgroundImage, main: getComputedStyle(document.querySelector(".main")!).backgroundColor };
  });
  expect(layer.position).toBe("fixed");
  expect(layer.image).toContain("linear-gradient(160deg");
  expect(layer.main).toBe("rgba(0, 0, 0, 0)");

  // A start to change: Deep sea, then its own colours, a third one, the direction and the shape.
  await editor.getByRole("button", { name: "Deep sea", exact: true }).click();
  expect((await root(page)).backdropCss).toContain("linear-gradient(180deg, #03111f, #0b4a6f)");
  await editor.getByLabel("Gradient colour 2", { exact: true }).fill("#7a1fa2");
  await editor.getByRole("button", { name: "Add a colour", exact: true }).click();
  await editor.getByLabel("Gradient colour 3", { exact: true }).fill("#ffd400");
  const direction = editor.getByRole("slider", { name: "Direction", exact: true });
  await direction.focus();
  await page.keyboard.press("ArrowRight");
  await expect(direction).toHaveValue("185");
  r = await root(page);
  expect(r.backdropCss).toContain("linear-gradient(185deg, #03111f, #7a1fa2, #ffd400)");
  // Bright yellow at one end: the gradient is dimmed just enough for words to read all the way down.
  await expectReadable(page, "a gradient into bright yellow");
  await editor.getByRole("radiogroup", { name: "Gradient shape", exact: true }).getByRole("radio", { name: "Round", exact: true }).click();
  expect((await root(page)).backdropCss).toContain("radial-gradient(");
  await expect(direction).toHaveCount(0);

  // Panels: see-through with a blur behind the bars, down to solid.
  r = await root(page);
  expect(r.glass).toBe("1");
  expect(r.surface).toMatch(/^rgba\(/);
  expect(r.filter).toContain("blur(20px)");
  const bar = () => page.evaluate(() => { const s = getComputedStyle(document.querySelector(".topbar")!); return s.backdropFilter || (s as unknown as Record<string, string>).webkitBackdropFilter; });
  expect(await bar()).toContain("blur(20px)");
  // Never on a card: only the bars and what opens over the page blur.
  expect(await page.evaluate(() => [...document.querySelectorAll(".card, .msg, .list-group")].filter((el) => { const s = getComputedStyle(el); return (s.backdropFilter || "none") !== "none"; }).length)).toBe(0);
  const through = editor.getByRole("slider", { name: "See-through", exact: true });
  await through.focus();
  await page.keyboard.press("Home");
  await expect(through).toHaveValue("0");
  r = await root(page);
  expect(r.glass).toBeNull();
  expect(r.surface).toMatch(/^#/);
  expect(r.filter).toBe("none");
  expect(await bar()).toBe("none");
  await page.keyboard.press("End");
  expect((await root(page)).glass).toBe("1");

  // "Reduce see-through effects" does the same for any theme with a backdrop, and says so.
  const calm = page.locator('label.switch[aria-label="Reduce see-through effects"]');
  await calm.click();
  await expect(calm.locator("input")).toBeChecked();
  r = await root(page);
  expect([r.glass, r.filter, r.backdrop]).toEqual([null, "none", "gradient"]);
  expect(r.surface).toMatch(/^#/);
  await expectReadable(page, "a gradient with solid panels");
  await calm.click();
  expect((await root(page)).glass).toBe("1");
  await noHorizontalOverflow(page);
});

/** A picture made in the browser: `w` × `h`, a sky-to-sand photo stand-in, or black and white squares (the hardest to read on). */
async function picture(page: Page, w: number, h: number, kind: "photo" | "checks") {
  const data = await page.evaluate(
    ({ w, h, kind }) => {
      const c = document.createElement("canvas");
      c.width = w;
      c.height = h;
      const ctx = c.getContext("2d")!;
      if (kind === "photo") {
        const g = ctx.createLinearGradient(0, 0, w, h);
        g.addColorStop(0, "#2a6fdb");
        g.addColorStop(0.5, "#f6c36b");
        g.addColorStop(1, "#d9422b");
        ctx.fillStyle = g;
        ctx.fillRect(0, 0, w, h);
        ctx.fillStyle = "#ffffff";
        ctx.beginPath();
        ctx.arc(w * 0.7, h * 0.3, Math.min(w, h) * 0.12, 0, Math.PI * 2);
        ctx.fill();
      } else {
        const step = Math.max(w, h) / 8;
        for (let y = 0; y * step < h; y++) for (let x = 0; x * step < w; x++) {
          ctx.fillStyle = (x + y) % 2 ? "#ffffff" : "#000000";
          ctx.fillRect(x * step, y * step, step, step);
        }
      }
      return c.toDataURL("image/jpeg", 0.8).split(",")[1];
    },
    { w, h, kind },
  );
  return { name: `${kind}.jpg`, mimeType: "image/jpeg", buffer: Buffer.from(data, "base64") };
}

/** The picture kept on this device: how big it is, or null when there's none. */
const keptPicture = (page: Page) =>
  page.evaluate(async () => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const req = indexedDB.open("crosstalk-theme", 1);
      req.onupgradeneeded = () => req.result.createObjectStore("picture");
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    const kept = await new Promise<{ bytes: ArrayBuffer; type: string } | undefined>((resolve, reject) => {
      const req = db.transaction("picture").objectStore("picture").get("background");
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    db.close();
    if (!kept) return null;
    const blob = new Blob([kept.bytes], { type: kept.type });
    const bitmap = await createImageBitmap(blob);
    return { width: bitmap.width, height: bitmap.height, bytes: blob.size, type: blob.type };
  });

test("your own picture: made smaller, kept on the device, blurred and dimmed, and words still read on it", async ({ page }) => {
  test.setTimeout(90_000);
  const tiles = await openTheme(page);
  await tile(page, "Your own").click();
  const editor = page.getByRole("region", { name: "Your own theme", exact: true });
  await editor.getByRole("radiogroup", { name: "Background", exact: true }).getByRole("radio", { name: "Picture", exact: true }).click();
  // Nothing chosen yet: your colours show, and nothing is kept.
  await expect(editor.locator(".theme-choose")).toBeVisible();
  expect((await root(page)).backdrop).toBeNull();
  expect(await keptPicture(page)).toBeNull();

  // A photo bigger than a phone's screen by far.
  await editor.getByLabel("Choose a picture", { exact: true }).setInputFiles(await picture(page, 4000, 3000, "photo"));
  await expect(editor.getByRole("button", { name: "Change picture", exact: true })).toBeVisible();
  await expect.poll(async () => (await root(page)).picture).toBe("ready");
  const kept = await keptPicture(page);
  expect(kept).not.toBeNull();
  expect([kept!.width, kept!.height, kept!.type]).toEqual([2560, 1920, "image/jpeg"]);
  let r = await root(page);
  expect(r.backdrop).toBe("picture");
  expect(r.size).toBe("cover");
  // One fixed layer holds it, with the veil over it; the page's own colour is the picture's on the whole.
  const layer = () => page.evaluate(() => { const s = getComputedStyle(document.body, "::before"); return { position: s.position, image: s.backgroundImage, filter: s.filter, size: s.backgroundSize, pos: s.backgroundPosition, opacity: s.opacity }; });
  let l = await layer();
  expect(l.position).toBe("fixed");
  expect(l.image).toContain("blob:");
  expect(l.filter).toBe("blur(12px)");
  await expect.poll(async () => (await layer()).opacity).toBe("1");
  await expectReadable(page, "a photo, as chosen");

  // Blur and dim, by the keyboard: sharp and as bright as reads well, then soft and dark.
  const blur = editor.getByRole("slider", { name: "Blur", exact: true });
  const dim = editor.getByRole("slider", { name: "Dim", exact: true });
  await blur.focus();
  await page.keyboard.press("Home");
  await expect(blur).toHaveValue("0");
  await expect(blur).toHaveAttribute("aria-valuetext", "Off");
  expect((await layer()).filter).toMatch(/^(none|blur\(0px\))$/);
  await dim.focus();
  await page.keyboard.press("Home");
  const veil = async () => Number(/rgba\(\d+, \d+, \d+, ([\d.]+)\)/.exec((await root(page)).backdropCss)?.[1] ?? "0");
  const least = await veil();
  // Dragged to nothing, the veil is still what the picture needs for words to read.
  expect(least).toBeGreaterThan(0);
  await expectReadable(page, "a photo, sharp and as bright as it gets");
  await page.keyboard.press("End");
  expect(await veil()).toBeGreaterThan(least);
  await blur.focus();
  await page.keyboard.press("End");
  expect((await layer()).filter).toBe("blur(40px)");

  // How it sits.
  await editor.getByRole("radiogroup", { name: "How the picture sits", exact: true }).getByRole("radio", { name: "Show all of it", exact: true }).click();
  expect((await layer()).size).toContain("contain");
  const across = editor.getByRole("slider", { name: "Left to right", exact: true });
  await across.focus();
  await page.keyboard.press("Home");
  expect((await layer()).pos).toContain("0% 50%");
  await editor.getByRole("radiogroup", { name: "How the picture sits", exact: true }).getByRole("radio", { name: "Fill the screen", exact: true }).click();
  await noHorizontalOverflow(page);

  // After a reload the page comes up in the picture's own colour before the app loads, then the picture is back.
  const average = (await root(page)).bg;
  await page.route("**/src/main.tsx*", (route) => route.abort());
  await page.reload();
  await expect.poll(() => page.evaluate(() => document.readyState)).not.toBe("loading");
  r = await root(page);
  expect([r.theme, r.backdrop, r.bg, r.picture]).toEqual(["custom", "picture", average, null]);
  expect(await page.evaluate(() => getComputedStyle(document.body).backgroundColor)).not.toBe("rgb(0, 0, 0)");
  await page.unroute("**/src/main.tsx*");
  await page.reload();
  await expect.poll(async () => (await root(page)).picture).toBe("ready");
  expect((await layer()).image).toContain("blob:");
  await expect(tiles.getByRole("radio", { name: /^Your own\./ })).toHaveAttribute("aria-checked", "true");

  // The hardest picture to read on, black and white squares, with no blur and no extra dim: still readable.
  await editor.getByLabel("Choose a picture", { exact: true }).setInputFiles(await picture(page, 900, 1600, "checks"));
  await expect.poll(async () => (await keptPicture(page))?.height).toBe(1600);
  await blur.focus();
  await page.keyboard.press("Home");
  await dim.focus();
  await page.keyboard.press("Home");
  await page.getByRole("slider", { name: "See-through", exact: true }).focus();
  await page.keyboard.press("End");
  await expect.poll(async () => (await layer()).filter).toMatch(/^(none|blur\(0px\))$/);
  await expectReadable(page, "black and white squares, sharp, glass panels");

  // Something that isn't a picture is refused in plain words, and the one in use stays.
  await editor.getByLabel("Choose a picture", { exact: true }).setInputFiles({ name: "notes.txt", mimeType: "text/plain", buffer: Buffer.from("not a picture") });
  await expect(page.locator(".toast")).toContainText("isn't a picture");
  expect((await keptPicture(page))?.height).toBe(1600);

  // Remove picture: two taps, and it's off the device.
  await editor.getByRole("button", { name: "Remove picture", exact: true }).click();
  await pastDoubleTap(page);
  await editor.getByRole("button", { name: "Remove", exact: true }).click();
  await expect(editor.locator(".theme-choose")).toBeVisible();
  await expect.poll(() => keptPicture(page)).toBeNull();
  r = await root(page);
  expect([r.backdrop, r.picture]).toEqual([null, null]);
});

test("Reset theme goes back to OLED black and takes your own theme and its picture off the device", async ({ page }) => {
  await saved(page, custom({ base: "gradient", accent: "#ff9f43" }));
  await openTheme(page);
  expect((await root(page)).backdrop).toBe("gradient");
  const editor = page.getByRole("region", { name: "Your own theme", exact: true });
  await editor.getByRole("radiogroup", { name: "Background", exact: true }).getByRole("radio", { name: "Picture", exact: true }).click();
  await editor.getByLabel("Choose a picture", { exact: true }).setInputFiles(await picture(page, 640, 480, "photo"));
  await expect.poll(async () => (await root(page)).picture).toBe("ready");
  // Asked first.
  await page.getByRole("button", { name: "Reset theme", exact: true }).click();
  await expect(page.getByText("Back to OLED black, and your own theme and picture are removed from this device.", { exact: true })).toBeVisible();
  await pastDoubleTap(page);
  await page.locator(".theme-reset").getByRole("button", { name: "Reset", exact: true }).click();
  await expect(tile(page, "OLED black")).toHaveAttribute("aria-checked", "true");
  const r = await root(page);
  expect([r.theme, r.backdrop, r.picture, r.bg, r.page, r.bar, r.stored]).toEqual([null, null, null, "#000000", "rgb(0, 0, 0)", "#000000", null]);
  for (const name of ["--bg", "--surface", "--text", "--accent", "--backdrop"]) expect(r.inline, name).not.toContain(name);
  await expect.poll(() => keptPicture(page)).toBeNull();
  await expect(page.getByRole("button", { name: "Reset theme", exact: true })).toBeDisabled();
  // Nothing left for the next start either.
  await page.reload();
  await expect(tile(page, "OLED black")).toHaveAttribute("aria-checked", "true");
  expect((await root(page)).theme).toBeNull();
});

test("a preset can be the start of your own theme", async ({ page }) => {
  await openTheme(page);
  await tile(page, "Sunset").click();
  await page.getByRole("button", { name: "Change this theme", exact: true }).click();
  const editor = page.getByRole("region", { name: "Your own theme", exact: true });
  await expect(editor).toBeVisible();
  await expect(tile(page, "Your own")).toHaveAttribute("aria-checked", "true");
  await expect(editor.getByRole("radiogroup", { name: "Background", exact: true }).getByRole("radio", { name: "Gradient", exact: true })).toHaveAttribute("aria-checked", "true");
  expect((await root(page)).backdropCss).toContain("#22104a");
  // With a theme of your own already made, it asks before replacing it.
  await tile(page, "Paper").click();
  await page.getByRole("button", { name: "Change this theme", exact: true }).click();
  await expect(page.getByText("This replaces your own theme's colours.", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(tile(page, "Paper")).toHaveAttribute("aria-checked", "true");
});

test("the Theme section fits a narrow phone and is found by search", async ({ page }) => {
  // Search finds it by what people call it.
  await page.goto("/#/settings");
  await page.getByRole("searchbox", { name: "Search settings", exact: true }).fill("dark");
  await page.getByRole("region", { name: "Search results", exact: true }).getByRole("button", { name: /^Theme/ }).click();
  await expect(page.getByRole("heading", { name: "Theme", exact: true })).toBeVisible();
  await expect(page.getByRole("radiogroup", { name: "Theme", exact: true })).toBeVisible();

  // Every part of your own theme open in turn: nothing wider than the screen.
  await tile(page, "Your own").click();
  const editor = page.getByRole("region", { name: "Your own theme", exact: true });
  for (const base of ["Colour", "Gradient", "Picture"]) {
    await editor.getByRole("radiogroup", { name: "Background", exact: true }).getByRole("radio", { name: base, exact: true }).click();
    await noHorizontalOverflow(page);
  }
  await editor.getByLabel("Choose a picture", { exact: true }).setInputFiles(await picture(page, 800, 600, "photo"));
  await expect(editor.getByRole("button", { name: "Change picture", exact: true })).toBeVisible();
  await noHorizontalOverflow(page);
  const inside = await page.evaluate(() => {
    const card = document.querySelector(".theme-editor")!.getBoundingClientRect();
    return [...document.querySelectorAll(".theme-editor *, .theme-card *")].filter((el) => { const r = el.getBoundingClientRect(); return r.width > 0 && (r.right > card.right + 1 || r.left < card.left - 1); }).map((el) => el.className);
  });
  expect(inside, "nothing sticks out of its card").toEqual([]);
  await page.getByRole("button", { name: "Reset theme", exact: true }).click();
  await pastDoubleTap(page);
  await page.locator(".theme-reset").getByRole("button", { name: "Reset", exact: true }).click();
  await expect(tile(page, "OLED black")).toHaveAttribute("aria-checked", "true");

});

test("on a touch screen every control of the Theme section is at least 44 px tall", async ({ page, browser }) => {
  test.skip(test.info().project.name !== "chromium-390", "one touch screen is enough");
  await page.goto("/");
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true, baseURL: "http://127.0.0.1:5198", reducedMotion: "reduce", serviceWorkers: "block" });
  try {
    const phone = await context.newPage();
    const conn = await page.evaluate(() => localStorage.getItem("crosstalk.conn.v1"));
    await phone.addInitScript(([conn, key, value]) => { localStorage.setItem("crosstalk.conn.v1", conn!); if (!localStorage.getItem(key)) localStorage.setItem(key, value); }, [conn, THEME_KEY, serialize(custom({ base: "gradient" }), paintFor(custom({ base: "gradient" })))] as const);
    await phone.goto("/#/settings/appearance");
    await expect(phone.getByRole("region", { name: "Your own theme", exact: true })).toBeVisible();
    const small = await phone.evaluate(() =>
      [...document.querySelectorAll<HTMLElement>(".theme-tile, .theme-seg button, .theme-swatch, .theme-start, .theme-range input, .theme-from .btn, .theme-reset .btn, .theme-editor-foot .btn, .theme-card ~ .card .switch")]
        .map((el) => {
          // A dashed "add" square is drawn 30 px; its tap is the 44 px around it.
          const r = el.matches(".theme-swatch.add") ? { height: el.getBoundingClientRect().height + 14 } : el.getBoundingClientRect();
          return { name: el.getAttribute("aria-label") ?? el.textContent?.trim() ?? el.className, h: Math.round(r.height) };
        })
        .filter((x) => x.h < 44),
    );
    expect(small, "controls shorter than 44 px").toEqual([]);
    expect(await phone.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
  } finally {
    await context.close();
  }
});

test("the terminal is drawn in the theme's colours, and follows a change of theme while it's open", async ({ page }) => {
  await saved(page, preset("light"));
  const info = { id: "theme-shell", title: "Shell", cols: 80, rows: 24, alive: true, createdAt: Date.now(), exitCode: null };
  const scrollback = "$ git status\r\nOn branch main\r\n\x1b[32mnothing to commit\x1b[0m, \x1b[33mworking tree clean\x1b[0m\r\n$ ls\r\n\x1b[34msrc\x1b[0m  \x1b[36mREADME.md\x1b[0m  \x1b[31mbroken.log\x1b[0m  \x1b[93mnotes.txt\x1b[0m\r\n$ ";
  await page.route("**/api/pty**", (route) => {
    const method = route.request().method();
    return route.fulfill(method === "DELETE" ? { json: { ok: true } } : method === "POST" ? { json: info } : { json: { info, scrollback } });
  });
  await page.goto("/#/terminal");
  await page.getByRole("button", { name: "Open a shell", exact: true }).click();
  await expect(page.locator(".xterm-viewport")).toBeVisible();
  const rgb = (hex: string) => `rgb(${parseInt(hex.slice(1, 3), 16)}, ${parseInt(hex.slice(3, 5), 16)}, ${parseInt(hex.slice(5, 7), 16)})`;
  const drawn = () =>
    page.evaluate(() => ({
      screen: getComputedStyle(document.querySelector(".xterm-viewport")!).backgroundColor,
      box: getComputedStyle(document.querySelector(".term-box")!).backgroundColor,
    }));
  const light = paintFor(preset("light"))!;
  await expect.poll(drawn).toEqual({ screen: rgb(light.vars["--term-screen"]), box: rgb(light.vars["--term-bg"]) });
  if (process.env.CT_SHOTS && /^chromium-(390|1440)$/.test(test.info().project.name)) {
    mkdirSync(join(process.env.CT_SHOTS, test.info().project.name), { recursive: true });
    await page.screenshot({ path: join(process.env.CT_SHOTS, test.info().project.name, "light-8-terminal.png"), animations: "disabled" });
  }
  // The theme changes with the shell open: its colours follow, without opening it again.
  const change = (settings: ThemeSettings) => page.evaluate(async (settings) => (await import("/src/themeDevice.ts" as string)).setTheme(settings), settings);
  await change(preset("midnight"));
  const midnight = paintFor(preset("midnight"))!;
  await expect.poll(drawn).toEqual({ screen: rgb(midnight.vars["--term-screen"]), box: rgb(midnight.vars["--term-bg"]) });
  // And OLED black's own are what they always were.
  await change(DEFAULT_SETTINGS);
  await expect.poll(drawn).toEqual({ screen: "rgb(0, 0, 0)", box: "rgb(16, 16, 18)" });
});

// ------------------------------------------------------------ screens to look at (CT_SHOTS)

const SETUPS: { id: string; settings: ThemeSettings; picture?: "photo" | "checks" }[] = [
  ...PRESETS.map((p) => ({ id: p.id, settings: preset(p.id) })),
  { id: "own-colour", settings: custom({ base: "color", background: "#2b1a3a", accent: "#ffd60a", round: 90 }) },
  { id: "own-colour-light", settings: custom({ base: "color", background: "#e8f1ea", accent: "#3ec468", round: 15 }) },
  { id: "own-gradient", settings: custom({ base: "gradient", accent: "#ff6fb5", gradient: { shape: "radial", angle: 0, stops: ["#6b2a8f", "#2a1458", "#0c0a1c"] }, seeThrough: 100, panelBlur: 24 }) },
  { id: "own-gradient-light", settings: custom({ base: "gradient", accent: "#a78bfa", gradient: { shape: "linear", angle: 135, stops: ["#ffd6e8", "#d6e4ff"] } }) },
  { id: "own-picture", settings: custom({ base: "picture", accent: "#ffd60a" }), picture: "photo" },
  { id: "own-picture-sharp", settings: custom({ base: "picture", accent: "#38bdf8", picture: { ...DEFAULT_CUSTOM.picture, blur: 0, dim: 0 }, seeThrough: 100, panelBlur: 30 }), picture: "photo" },
  { id: "glass-solid", settings: { ...preset("glass"), calm: true } },
];

for (const setup of SETUPS) {
  test(`screens to look at: ${setup.id}`, async ({ page, request, token }) => {
    test.skip(!process.env.CT_SHOTS, "set CT_SHOTS to a folder to save the screens");
    test.skip(!/^chromium-(390|1440)$/.test(test.info().project.name) && !(test.info().project.name === "webkit-390" && ["glass", "light", "own-picture"].includes(setup.id)), "phones and a computer");
    test.setTimeout(90_000);
    const width = page.viewportSize()!.width;
    if (width === 390) await page.setViewportSize({ width: 390, height: 844 });
    const dir = join(process.env.CT_SHOTS!, test.info().project.name);
    mkdirSync(dir, { recursive: true });
    const shot = (name: string) => page.screenshot({ path: join(dir, `${setup.id}-${name}.png`), animations: "disabled" });
    const chat = await chatWithMessages(page, request, token);
    try {
      if (setup.picture) {
        // Chosen the way a person does, so it's in this browser's storage; then the look is put on.
        await page.goto("/#/settings/appearance");
        await tile(page, "Your own").click();
        const editor = page.getByRole("region", { name: "Your own theme", exact: true });
        await editor.getByRole("radiogroup", { name: "Background", exact: true }).getByRole("radio", { name: "Picture", exact: true }).click();
        await editor.getByLabel("Choose a picture", { exact: true }).setInputFiles(await picture(page, 1600, 2400, setup.picture));
        await expect.poll(async () => (await root(page)).picture).toBe("ready");
        // The rest of the setup, with the picture's own numbers kept.
        await page.evaluate(
          ([key, wanted]) => {
            const now = JSON.parse(localStorage.getItem(key)!);
            const next = JSON.parse(wanted);
            next.custom.picture = { ...next.custom.picture, average: now.custom.picture.average, lo: now.custom.picture.lo, hi: now.custom.picture.hi };
            localStorage.setItem(key, JSON.stringify({ ...next, paint: null }));
          },
          [THEME_KEY, JSON.stringify(setup.settings)] as const,
        );
        await page.reload();
      } else {
        await saved(page, setup.settings);
      }
      await page.goto("/#/");
      await expect(page.getByRole("heading", { name: "What agent do you want to use?", exact: true })).toBeVisible();
      if (setup.picture) await expect.poll(async () => (await root(page)).picture).toBe("ready");
      await shot("1-home");
      await chat.open();
      await shot("2-chat");
      await page.goto("/#/settings/appearance");
      await expect(page.getByRole("radiogroup", { name: "Theme", exact: true })).toBeVisible();
      await shot("4-settings");
      await page.goto("/#/settings");
      await expect(page.getByRole("navigation", { name: "Settings pages" })).toBeVisible();
      await shot("5-settings-list");
      await page.goto("/#/agent/codex");
      await page.getByRole("button", { name: "New chat", exact: true }).last().click();
      await expect(page.getByRole("dialog", { name: "New chat with Codex", exact: true })).toBeVisible();
      await shot("6-new-chat");
      // The chats drawer last: it stays open across screens.
      await page.keyboard.press("Escape");
      await chat.open();
      if (width < 761) {
        await page.getByRole("button", { name: /^Show chats/ }).click();
        await expect(page.getByRole("complementary", { name: "Chats", exact: true })).toBeVisible();
        await shot("3-chats");
      }
      // Your own theme's controls, all of them at once, on a screen made tall enough to hold them.
      if (setup.settings.theme === CUSTOM_THEME && width < 761) {
        await page.reload();
        await page.setViewportSize({ width, height: 2900 });
        await page.goto("/#/settings/device");
        await expect(page.getByRole("region", { name: "Your own theme", exact: true })).toBeVisible();
        if (setup.picture) await expect.poll(async () => (await root(page)).picture).toBe("ready");
        await shot("7-your-own");
      }
    } finally {
      await chat.cleanup();
    }
  });
}
