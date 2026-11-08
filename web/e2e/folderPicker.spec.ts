import type { Room } from "@crosstalk/shared";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { test, expect, noHorizontalOverflow } from "./fixtures";

// The folder picker in New chat (FolderPicker.tsx, GET /api/folders): every folder the machine has, as a list to tap, with
// a field under it for any other path that narrows the list as it's typed. Phone widths, where the list must fit.

const HUB = "http://127.0.0.1:8451";
// CT_SHOTS: a folder to save the screens in, to look at them.
const shot = (name: string) => (process.env.CT_SHOTS ? { path: join(process.env.CT_SHOTS, name) } : {});
const project = () => test.info().project.name;
const onPhones = () => test.skip(!/-(320|390)$/.test(project()), "Phone widths: the 320 and 390 projects.");

test("New chat lists the machine's folders, narrows them as a path is typed, and starts the chat in the one tapped", async ({ page, request, token }) => {
  onPhones();
  const width = page.viewportSize()!.width;
  await page.setViewportSize({ width, height: 844 });
  const headers = { authorization: `Bearer ${token}` };
  const { root } = (await (await request.get(`${HUB}/api/folders`, { headers })).json()) as { root: string };
  const tag = Math.random().toString(36).slice(2, 6);
  const mine = [join(root, `Picker-apple-${tag}`), join(root, `Picker-berry-${tag}`)];
  for (const f of mine) mkdirSync(f);
  const made: string[] = [];
  try {
    await page.goto("/#/agent/codex");
    await page.getByRole("button", { name: "New chat", exact: true }).last().click();
    const dialog = page.getByRole("dialog", { name: "New chat with Codex", exact: true });
    await expect(dialog).toBeVisible();
    const list = dialog.getByRole("radiogroup", { name: "Folder", exact: true });
    // "A new folder" is picked to start with; the machine's folders are listed below it.
    await expect(list.getByRole("radio", { name: "A new folder", exact: true })).toHaveAttribute("aria-checked", "true");
    const apple = list.getByRole("radio", { name: `Picker-apple-${tag}, ${mine[0]}`, exact: true });
    const berry = list.getByRole("radio", { name: `Picker-berry-${tag}, ${mine[1]}`, exact: true });
    await expect(apple).toBeVisible();
    await expect(berry).toBeAttached();
    await noHorizontalOverflow(page);
    expect(await dialog.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true);
    await page.screenshot({ ...shot(`folder-picker-${width}.png`), animations: "disabled" });

    // The path field is under the list, and typing in it narrows the list.
    const field = dialog.getByRole("textbox", { name: "Folder path", exact: true });
    const [listBox, fieldBox] = [await list.boundingBox(), await field.boundingBox()];
    expect(fieldBox!.y).toBeGreaterThanOrEqual(listBox!.y + listBox!.height - 1);
    await field.fill(`berry-${tag}`);
    await expect(berry).toBeVisible();
    await expect(apple).toHaveCount(0);
    await field.fill(`/nowhere-${tag}`);
    await expect(dialog.getByText("No folder here matches. The path you typed is used.")).toBeVisible();

    // Tapping a folder picks it and empties the field; the chat starts there.
    await field.fill("");
    await expect(list.getByRole("radio", { name: "A new folder", exact: true })).toHaveAttribute("aria-checked", "true");
    await apple.click();
    await expect(apple).toHaveAttribute("aria-checked", "true");
    await expect(field).toHaveValue("");
    const created = page.waitForResponse((r) => r.url().endsWith("/api/chats") && r.request().method() === "POST");
    await dialog.getByRole("button", { name: "Start chat", exact: true }).click();
    const room = (await (await created).json()) as Room;
    made.push(room.id);
    expect(room.cwd).toBe(mine[0]);
  } finally {
    for (const id of made) await request.delete(`${HUB}/api/rooms/${id}`, { headers });
    for (const f of mine) rmSync(f, { recursive: true, force: true });
  }
});
