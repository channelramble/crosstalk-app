import { test, expect, noHorizontalOverflow } from "./fixtures";

const HUB = "http://127.0.0.1:8451";
const DAY = 86_400_000;

test("Paired devices: quiet devices are signed out unless that's switched off, and a line says when it's a week away", async ({ page, request, token }) => {
  const url = `${HUB}/api/settings/hub`;
  const headers = { authorization: `Bearer ${token}` };
  const before = await (await request.get(url, { headers })).json();
  try {
    // The machine's own list, with one device 26 days quiet, one that just spoke, and a linked machine as quiet.
    const real = (await (await request.get(`${HUB}/api/devices`, { headers })).json()) as Record<string, unknown>[];
    const now = Date.now();
    const made = (name: string, more: Record<string, unknown>) => ({ ...real[0], id: `dev-${name}`, name, current: false, createdAt: now - 60 * DAY, lastSeenAt: now - DAY, ...more });
    await page.route("**/api/devices", (route) =>
      route.request().method() === "GET"
        ? route.fulfill({
            json: [
              ...real,
              made("Old tablet", { lastMessageAt: now - 26 * DAY - 3_600_000 }),
              made("Laptop", { lastMessageAt: now - DAY }),
              made("Workshop", { platform: "Crosstalk hub", lastMessageAt: now - 29 * DAY }),
            ],
          })
        : route.fallback(),
    );
    await page.goto("/#/settings/devices");
    const toggle = page.getByRole("checkbox", { name: "Sign out devices that go quiet", exact: true });
    // On unless someone switched it off.
    await expect(toggle).toBeChecked();
    const row = (name: string) => page.locator(".list-row", { hasText: name });
    await expect(row("Old tablet")).toContainText("signs out in 4 days unless it sends a message");
    await expect(row("Laptop")).not.toContainText("signs out");
    // A linked machine is never signed out this way, and its line doesn't say it will be.
    await expect(row("Workshop")).not.toContainText("signs out");
    await noHorizontalOverflow(page);

    await toggle.uncheck();
    await expect.poll(async () => (await (await request.get(url, { headers })).json()).idleSignOutDays).toBe(0);
    await expect(row("Old tablet")).not.toContainText("signs out");
    await page.reload();
    await expect(toggle).not.toBeChecked();
    await toggle.check();
    // Back at the usual 30, which is saved as nothing.
    await expect.poll(async () => (await (await request.get(url, { headers })).json()).idleSignOutDays ?? 30).toBe(30);
    await expect(row("Old tablet")).toContainText("signs out in 4 days");
  } finally {
    await request.put(url, { headers, data: { idleSignOutDays: before.idleSignOutDays ?? 30 } });
  }
});

test("Agents together: other machines' agents drive chats that act without asking only once that's switched on", async ({ page, request, token }) => {
  const url = `${HUB}/api/settings/hub`;
  const headers = { authorization: `Bearer ${token}` };
  const before = await (await request.get(url, { headers })).json();
  try {
    await request.put(url, { headers, data: { agentsAcrossChats: true, agentsFromMachinesAct: false } });
    await page.goto("/#/settings/teamwork");
    const toggle = page.getByRole("checkbox", { name: "Let other machines' agents drive chats that act without asking", exact: true });
    await expect(toggle).not.toBeChecked();
    await noHorizontalOverflow(page);
    await toggle.check();
    await expect.poll(async () => (await (await request.get(url, { headers })).json()).agentsFromMachinesAct).toBe(true);
    await page.reload();
    await expect(toggle).toBeChecked();
    await toggle.uncheck();
    await expect.poll(async () => !!(await (await request.get(url, { headers })).json()).agentsFromMachinesAct).toBe(false);
  } finally {
    await request.put(url, { headers, data: { agentsAcrossChats: !!before.agentsAcrossChats, agentsFromMachinesAct: !!before.agentsFromMachinesAct } });
  }
});
