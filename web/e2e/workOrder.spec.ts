import { test, expect, noHorizontalOverflow } from "./fixtures";

// The turn order in a group chat (a room made the older way is one): who answers is said above the message box before
// you send, each agent at work has its own status line, and who's next is said under them.

test("asking the reviewer directly: only it answers, and no build is promised", async ({ page, request, token }) => {
  const headers = { authorization: `Bearer ${token}` };
  const room = await (await request.post("http://127.0.0.1:8451/api/rooms", { headers, data: { name: "Direct reviewer answer", mode: "review" } })).json();
  await request.post(`http://127.0.0.1:8451/api/rooms/${room.id}/members`, { headers, data: { provider: "mock", handle: "builder", config: { reply: "Built the change." } } });
  await request.post(`http://127.0.0.1:8451/api/rooms/${room.id}/members`, { headers, data: { provider: "mock", handle: "reviewer", config: { reply: "The port is 7420.", delayMs: 1800 } } });
  try {
    await page.goto(`/#/room/${room.id}`);
    await page.getByRole("textbox", { name: "Message", exact: true }).fill("@reviewer which port?");
    await expect(page.locator(".group-answers")).toHaveText("Only @reviewer will answer. The others read it on their next turn.");
    await page.getByRole("button", { name: "Send to @reviewer", exact: true }).click();
    await expect(page.getByRole("button", { name: /^@reviewer: / })).toBeVisible();
    await expect(page.getByRole("button", { name: /^@builder: / })).toHaveCount(0);
    await expect(page.getByLabel("Turn order", { exact: true })).toHaveCount(0);
    await noHorizontalOverflow(page);
    await expect(page.locator(".messages")).toContainText("The port is 7420.");
    await expect(page.getByRole("button", { name: /^@reviewer: / })).toHaveCount(0);
    const history = await (await request.get(`http://127.0.0.1:8451/api/rooms/${room.id}/history`, { headers })).json();
    expect(history.turns).toHaveLength(1);
    expect(history.turns[0].origin).toBe("human");
  } finally { await request.delete(`http://127.0.0.1:8451/api/rooms/${room.id}`, { headers }); }
});

test("build and review say who builds and who checks before you send, then show each at work until it's approved", async ({ page, request, token }) => {
  const headers = { authorization: `Bearer ${token}` };
  const room = await (await request.post("http://127.0.0.1:8451/api/rooms", { headers, data: { name: "Visible order", mode: "review", maxHops: 5 } })).json();
  await request.post(`http://127.0.0.1:8451/api/rooms/${room.id}/members`, { headers, data: { provider: "mock", handle: "builder", config: { reply: "Built the change.", delayMs: 1800 } } });
  await request.post(`http://127.0.0.1:8451/api/rooms/${room.id}/members`, { headers, data: { provider: "mock", handle: "reviewer", config: { reply: "APPROVED: checked the change.", delayMs: 1800 } } });
  try {
    await page.goto(`/#/room/${room.id}`);
    await expect(page.locator(".group-answers")).toHaveText("@builder builds it, then @reviewer checks the work.");
    await page.getByRole("textbox", { name: "Message", exact: true }).fill("Do the task");
    await page.getByRole("button", { name: "Send", exact: true }).click();
    await expect(page.getByRole("button", { name: /^@builder: / })).toBeVisible();
    await noHorizontalOverflow(page);
    await page.screenshot({ path: test.info().outputPath("building.png") });
    await expect(page.getByRole("button", { name: /^@reviewer: / })).toBeVisible();
    await expect(page.getByRole("button", { name: /^@builder: / })).toHaveCount(0);
    await expect(page.locator(".messages")).toContainText("approved @builder's work");
    await expect(page.getByRole("button", { name: /^@reviewer: / })).toHaveCount(0);
  } finally { await request.delete(`http://127.0.0.1:8451/api/rooms/${room.id}`, { headers }); }
});

test("@all: the lead works first with who's next under it, and Stop all agents ends both", async ({ page, request, token }) => {
  const headers = { authorization: `Bearer ${token}` };
  const room = await (await request.post("http://127.0.0.1:8451/api/rooms", { headers, data: { name: "Off order", mode: "direct" } })).json();
  for (const handle of ["first", "second"]) await request.post(`http://127.0.0.1:8451/api/rooms/${room.id}/members`, { headers, data: { provider: "mock", handle, config: { delayMs: 5000 } } });
  try {
    await page.goto(`/#/room/${room.id}`);
    await page.getByRole("textbox", { name: "Message", exact: true }).fill("@all do the task");
    await expect(page.locator(".group-answers")).toHaveText("Everyone answers, in turn: @first, then @second.");
    await page.getByRole("button", { name: "Send to all: @first, then @second", exact: true }).click();
    const order = page.getByLabel("Turn order", { exact: true });
    await expect(order).toHaveText("Now: @first · Next: @second");
    await expect(page.getByRole("button", { name: /^@first: / })).toBeVisible();
    await expect(page.getByRole("button", { name: /^@second: / })).toHaveCount(0);
    // The second agent's turn is for the same message: Stop stops without asking about a message of yours waiting.
    await page.getByRole("button", { name: "Stop all agents", exact: true }).click();
    await expect(order).toHaveCount(0);
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await noHorizontalOverflow(page);
  } finally { await request.delete(`http://127.0.0.1:8451/api/rooms/${room.id}`, { headers }); }
});
