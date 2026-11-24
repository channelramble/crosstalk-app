import { test, expect } from "./fixtures";

// On a phone, the small controls around the message box take a finger: each answers a tap anywhere in a 44 px area,
// though it's drawn smaller (styles.css, "Phones: the small controls around the message box").

const HUB = "http://127.0.0.1:8451";

test("the + and the mic, and the row of chat settings, take a tap 44 px tall on a phone", async ({ page, request, token }) => {
  test.skip(!/-(320|390)$/.test(test.info().project.name), "phone widths");
  const headers = { authorization: `Bearer ${token}` };
  const chat = await (await request.post(`${HUB}/api/chats`, { headers, data: { provider: "codex", name: "Tap targets" } })).json();
  try {
    await page.goto(`/#/room/${chat.id}`);
    await expect(page.getByRole("textbox", { name: "Message", exact: true })).toBeVisible();
    await expect(page.locator(".chat-controls .ctl").first()).toBeVisible();
    // For each control: how tall and wide the area is where a tap lands on it (probed point by point).
    const areas = await page.evaluate(() => {
      const out: { name: string; w: number; h: number }[] = [];
      for (const el of document.querySelectorAll<HTMLElement>(".composer-icon, .chat-controls .ctl")) {
        const r = el.getBoundingClientRect();
        if (!r.width || !r.height) continue;
        const hits = (x: number, y: number) => {
          const at = document.elementFromPoint(x, y);
          return !!at && (at === el || el.contains(at));
        };
        const cx = r.left + r.width / 2;
        const cy = r.top + r.height / 2;
        let top = cy, bottom = cy, left = cx, right = cx;
        while (top > 0 && hits(cx, top - 1)) top--;
        while (bottom < innerHeight && hits(cx, bottom + 1)) bottom++;
        while (left > 0 && hits(left - 1, cy)) left--;
        while (right < innerWidth && hits(right + 1, cy)) right++;
        out.push({ name: el.getAttribute("aria-label") ?? el.textContent?.trim() ?? el.className, w: Math.round(right - left + 1), h: Math.round(bottom - top + 1) });
      }
      return out;
    });
    expect(areas.length).toBeGreaterThanOrEqual(5);
    for (const a of areas) {
      expect([a.name, a.h >= 43], `${a.name} takes a tap ${a.h} px tall`).toEqual([a.name, true]);
      expect([a.name, a.w >= 40], `${a.name} takes a tap ${a.w} px wide`).toEqual([a.name, true]);
    }
  } finally {
    await request.delete(`${HUB}/api/rooms/${chat.id}`, { headers });
  }
});
