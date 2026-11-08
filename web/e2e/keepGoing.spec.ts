import type { APIRequestContext, Page, Route } from "@playwright/test";
import type { Member, Room } from "@crosstalk/shared";
import { test, expect, noHorizontalOverflow } from "./fixtures";
import { otherMachine, pong } from "./otherMachine";

// Settings → Agents → Teamwork → "Keep going while helpers work" (HubSettings.messagesFlow), on a phone: the row itself at
// 390 and 320 px, and the switch bringing the bar back in an open chat, or hiding it, with no reload. The agent is the
// scripted mock one (its `helpers`, `steer` and `delays` knobs): nothing here sends a prompt to a real model, and no agent
// CLI runs. web/e2e/fixtures.ts puts the setting back after each test.

const HUB = "http://127.0.0.1:8451";
const shot = (name: string) => (process.env.CT_SHOTS ? { path: `${process.env.CT_SHOTS}/${name}` } : {});
const TITLE = "Keep going while helpers work";
const HELP = "Your messages go straight to the agent. New settings apply when its helpers finish. Off: messages wait for the helpers, so new settings apply first, and you can send one sooner by tapping.";
const ALWAYS = "An account switch, tighter permissions or a new folder always wait.";

const row = (page: Page) => page.getByRole("region", { name: TITLE, exact: true });
const theSwitch = (page: Page) => row(page).getByRole("checkbox", { name: TITLE, exact: true });
const bar = (page: Page) => page.locator(".send-now");
const button = (page: Page, name: string) => page.getByRole("button", { name, exact: true });

/** "Another device": the hub-wide setting, changed from outside this page. */
const setHub = (request: APIRequestContext, token: string, messagesFlow: boolean) => request.put(`${HUB}/api/settings/hub`, { headers: { authorization: `Bearer ${token}` }, data: { messagesFlow } });

/** A chat with the mock agent whose helper works for longer than a test runs and no reply running, open on the phone. */
async function helperAtWork(page: Page, request: APIRequestContext, token: string, name: string, config: Record<string, unknown> = {}, permissionMode?: Member["permissionMode"]) {
  const headers = { authorization: `Bearer ${token}` };
  const room: Room = await (await request.post(`${HUB}/api/rooms`, { headers, data: { name, mode: "direct" } })).json();
  const member: Member = await (await request.post(`${HUB}/api/rooms/${room.id}/members`, { headers, data: { provider: "mock", handle: "tester", config: { delayMs: 10, helpers: { ms: 120_000 }, ...config }, ...(permissionMode ? { permissionMode } : {}) } })).json();
  const agent = async (): Promise<Member> => ((await (await request.get(`${HUB}/api/state`, { headers })).json()).members as Member[]).find((m) => m.id === member.id)!;
  await request.post(`${HUB}/api/rooms/${room.id}/messages`, { headers, data: { text: "Install the browser" } });
  await expect.poll(async () => (await agent()).status).toBe("idle");
  await page.goto(`/#/room/${room.id}`);
  await expect(page.getByRole("region", { name: "Helpers", exact: true })).toContainText("1 helper working");
  return {
    room,
    member,
    agent,
    /** A setting changes while the helper works: it applies once the helper is done. */
    change: async (permission: Member["permissionMode"] = "edits") => {
      await request.patch(`${HUB}/api/members/${member.id}`, { headers, data: { permissionMode: permission } });
      await expect.poll(async () => (await agent()).held?.helpers).toBe(true);
    },
    send: async (text: string, on = page) => {
      await on.getByRole("textbox", { name: "Message", exact: true }).fill(text);
      await on.getByRole("button", { name: "Send", exact: true }).click();
    },
    remove: () => request.delete(`${HUB}/api/rooms/${room.id}`, { headers }),
  };
}

const AROUND = "Your new settings apply when @tester's helpers finish. Until then it answers with the settings it started with.";
const ANSWERING = "Answering now with the settings @tester started with. Your changes apply once its helpers finish.";
const HOLDS = "Your message is waiting for its helpers to finish, so your new settings apply first.";

for (const width of [390, 320]) {
  test(`at ${width} px the row fits, says what it does, and every part of it can be reached and read`, async ({ page }) => {
    await page.setViewportSize({ width, height: 844 });
    // Its own address, as every section of Settings has: the tab opens and it's on screen.
    await page.goto("/#/settings/keep-going");
    await expect(page.getByRole("tab", { name: "Agents", exact: true })).toHaveAttribute("aria-selected", "true");
    await expect(row(page)).toBeInViewport();
    await expect(row(page)).toContainText(TITLE);
    await expect(row(page)).toContainText(HELP);
    await expect(row(page)).toContainText(ALWAYS);
    // Beside Teamwork, in the Agents tab: where it's about who helps whom.
    const order = await page.evaluate((title) => {
      const at = (el: Element | null) => (el ? el.getBoundingClientRect().top : -1);
      return { teamwork: at(document.getElementById("teamwork")), keepGoing: at(document.querySelector(`[aria-label="${title}"]`)) };
    }, TITLE);
    expect(order.teamwork).toBeLessThan(order.keepGoing);

    // On by default, and a finger's width and height.
    await expect(theSwitch(page)).toBeChecked();
    const box = (await theSwitch(page).boundingBox())!;
    expect(box.width).toBeGreaterThanOrEqual(44);
    expect(box.height).toBeGreaterThanOrEqual(44);
    // A screen reader hears the words with the switch.
    await expect(theSwitch(page)).toHaveAccessibleDescription(HELP);

    // Nothing wider than the screen, nothing cut off, and the switch inside its card.
    await noHorizontalOverflow(page);
    const fit = await row(page).evaluate((card) => {
      const r = card.getBoundingClientRect();
      const cut = [...card.querySelectorAll<HTMLElement>("*")].filter((el) => el.scrollWidth > el.clientWidth + 1 && getComputedStyle(el).display !== "inline").map((el) => el.className || el.tagName);
      const out = [...card.querySelectorAll<HTMLElement>("*")].filter((el) => el.getBoundingClientRect().right > r.right + 1).map((el) => el.className || el.tagName);
      return { cut, out, right: r.right };
    });
    expect(fit.cut).toEqual([]);
    expect(fit.out).toEqual([]);
    expect(fit.right).toBeLessThanOrEqual(width);
    await row(page).scrollIntoViewIfNeeded();
    await page.screenshot({ ...shot(`keep-going-row-${width}.png`), animations: "disabled" });

    // The keyboard: it can be reached and changed, and it keeps the focus through the save.
    await theSwitch(page).focus();
    await page.keyboard.press("Space");
    await expect(theSwitch(page)).not.toBeChecked();
    await expect(theSwitch(page)).toBeFocused();
    await expect(row(page).getByRole("status")).toContainText("Saves as you change it");
    await page.keyboard.press("Space");
    await expect(theSwitch(page)).toBeChecked();
    await expect(row(page).getByRole("status")).toContainText("Saves as you change it");
    await noHorizontalOverflow(page);
  });

  test(`at ${width} px the switch's failures say what happened, with a way on`, async ({ page }) => {
    await page.setViewportSize({ width, height: 844 });
    let failGet = true;
    let failPut = true;
    let saved = true;
    await page.route("**/api/settings/hub", async (route) => {
      const method = route.request().method();
      if (method === "GET" && failGet) return route.fulfill({ status: 503, json: { error: "The hub is restarting." } });
      if (method === "PUT" && failPut) return route.fulfill({ status: 503, json: { error: "The hub is restarting." } });
      if (method === "PUT") saved = route.request().postDataJSON().messagesFlow;
      const real = await route.fetch();
      return route.fulfill({ response: real, json: { ...(await real.json()), messagesFlow: saved } });
    });
    await page.goto("/#/settings/keep-going");
    const alert = row(page).getByRole("alert");
    await expect(alert).toContainText("Couldn't load this setting: The hub is restarting.");
    await noHorizontalOverflow(page);
    failGet = false;
    await alert.getByRole("button", { name: "Retry", exact: true }).click();
    await expect(theSwitch(page)).toBeChecked();
    // A save that fails: back to what's saved, saying so.
    await theSwitch(page).click();
    await expect(row(page).getByRole("alert")).toHaveText("Couldn't save: The hub is restarting. Change it again to retry.");
    await expect(theSwitch(page)).toBeChecked();
    await noHorizontalOverflow(page);
    await page.screenshot({ ...shot(`keep-going-failed-${width}.png`), animations: "disabled" });
    // Changing it again goes through, and the words go.
    failPut = false;
    await theSwitch(page).click();
    await expect(theSwitch(page)).not.toBeChecked();
    await expect(row(page).getByRole("alert")).toHaveCount(0);
    await expect(row(page).getByRole("status")).toContainText("Saves as you change it");
  });
}

for (const width of [390, 320]) test(`at ${width} px Off brings the bar back with Answer now, On hides it and the message goes, once, with one note: no reload, and two devices hear it`, async ({ page, request, token }) => {
  await page.setViewportSize({ width, height: 844 });
  const chat = await helperAtWork(page, request, token, "The switch and the bar");
  // A second device, with Settings open.
  const other = await page.context().newPage();
  await other.setViewportSize({ width: width === 390 ? 320 : 390, height: 844 });
  try {
    await other.goto("/#/settings/keep-going");
    await expect(theSwitch(other)).toBeChecked();
    await chat.change();
    const note = page.getByText(AROUND, { exact: true });

    // On: the message starts at once, with no bar and no button.
    await chat.send("Did it switch my model?");
    await expect(page.locator(".msg.agent").last()).toContainText("Turn 2");
    await expect(note).toHaveCount(1);
    await expect(bar(page)).toHaveCount(0);

    // Off, on the other device: this one goes by it at once, so the next message waits, and the bar says so.
    await theSwitch(other).click();
    await expect(theSwitch(other)).not.toBeChecked();
    await expect.poll(async () => (await (await request.get(`${HUB}/api/settings/hub`, { headers: { authorization: `Bearer ${token}` } })).json()).messagesFlow).toBe(false);
    await chat.send("And the docs?");
    await expect(bar(page)).toContainText(HOLDS);
    await expect(bar(page)).toContainText("Answer now uses the settings it started with.");
    await expect(bar(page)).not.toContainText("this reply to finish");
    await expect(button(page, "Answer now")).toBeVisible();
    await expect(button(page, "Send now")).toHaveCount(0);
    await expect(page.locator(".msg.agent").last()).not.toContainText("Turn 3");
    await noHorizontalOverflow(page);
    await page.screenshot({ ...shot(`keep-going-off-bar-${width}.png`), animations: "disabled" });

    // On again, from outside either page: both hear it. The bar goes, and the message goes, once, with the hold's one note.
    await setHub(request, token, true);
    await expect(bar(page)).toHaveCount(0);
    await expect(theSwitch(other)).toBeChecked();
    await expect(page.locator(".msg.agent").last()).toContainText("Turn 3");
    await expect(page.locator(".msg.agent").last()).toContainText("And the docs?");
    await expect(note).toHaveCount(1);
    await expect(page.getByRole("region", { name: "Helpers", exact: true })).toContainText("1 helper working");
    await page.waitForTimeout(150);
    await expect(page.getByText("Turn 4", { exact: false })).toHaveCount(0);

    // Off again: the next waits, and Answer now answers it with the agent as it is, said in the chat; the helper keeps going.
    await theSwitch(other).click();
    await expect(theSwitch(other)).not.toBeChecked();
    await expect.poll(async () => (await (await request.get(`${HUB}/api/state`, { headers: { authorization: `Bearer ${token}` } })).json()).hub.messagesFlow).toBe(false);
    await chat.send("Send the link too");
    await expect(bar(page)).toContainText(HOLDS);
    await bar(page).getByRole("button", { name: "Answer now", exact: true }).click();
    await expect(page.getByText(ANSWERING, { exact: true })).toBeVisible();
    await expect(page.locator(".msg.agent").last()).toContainText("Turn 4");
    await expect(bar(page)).toHaveCount(0);
    await expect(page.getByRole("region", { name: "Helpers", exact: true })).toContainText("1 helper working");
    await noHorizontalOverflow(page);
  } finally {
    await other.close();
    await chat.remove();
  }
});

test("Off with a reply running: nothing goes in without a tap, Send now does, and Read it now shows as it did; On hides the bar and it goes in", async ({ page, request, token }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  // Its second reply runs long enough to look at; the third would be a reply of its own, which never comes.
  const chat = await helperAtWork(page, request, token, "Off with a reply", { steer: true, delays: [10, 12_000] });
  try {
    await setHub(request, token, false);
    await chat.send("Build the setup step");
    await expect(page.locator(".msg.agent").last()).toContainText("Turn 2");
    await chat.send("Also add tests");
    await expect(bar(page)).toContainText("Your message is waiting for this reply to finish.");
    const sendNow = button(page, "Send now");
    await expect(sendNow).toBeVisible();
    await expect(page.locator(".msg-quiet")).toHaveCount(0);
    await noHorizontalOverflow(page);
    await page.screenshot({ ...shot("keep-going-off-send-now.png"), animations: "disabled" });
    await sendNow.click();
    await expect(bar(page)).toHaveCount(0);
    await expect(button(page, "Read it now")).toBeVisible();
    await expect(page.locator(".read-now")).toContainText("@tester");
    await noHorizontalOverflow(page);

    // What went in stays in; the same message now says it with a small label, and nothing more is sent.
    await setHub(request, token, true);
    await expect(page.locator(".msg-quiet")).toHaveText(/^@tester reads this (after the current step|at its next step)\.$/);
    await expect(button(page, "Read it now")).toHaveCount(0);

    // Off again, and another message: it waits for a tap. On: the bar goes, and it goes in by itself.
    await setHub(request, token, false);
    await expect(button(page, "Read it now")).toBeVisible();
    await chat.send("And the docs");
    await expect(sendNow).toBeVisible();
    await setHub(request, token, true);
    await expect(bar(page)).toHaveCount(0);
    await expect(sendNow).toHaveCount(0);
    await expect(page.locator(".msg-quiet")).toBeVisible();
    await expect(page.getByText("Turn 3", { exact: false })).toHaveCount(0);
  } finally {
    await chat.remove();
  }
});

test("Off: Stop everything gives a message back, and Answer now under it answers at once, in one tap, saying so", async ({ page, request, token }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const chat = await helperAtWork(page, request, token, "Off and Stop", { steer: true, delays: [10, 12_000, 10] });
  try {
    await setHub(request, token, false);
    await chat.send("Build the setup step");
    await expect(page.locator(".msg.agent").last()).toContainText("Turn 2");
    await chat.change();
    await chat.send("Also add tests");
    await button(page, "Send now").click();
    await expect(button(page, "Read it now")).toBeVisible();
    await button(page, "Stop all agents").click();
    const which = page.getByRole("dialog");
    await expect(which).toContainText("hasn't read your message yet.");
    await which.getByRole("button", { name: /^Stop everything/ }).click();
    await expect(which).toHaveCount(0);
    // Stopped, and it stays stopped: the message is yours again, under a hold that may last for hours.
    await expect(page.locator(".chat-status")).toContainText("Finishing helpers before your new settings apply");
    const answer = button(page, "Answer now");
    await expect(answer).toBeVisible();
    await expect(page.getByText("Turn 3", { exact: false })).toHaveCount(0);
    await noHorizontalOverflow(page);
    await answer.click();
    await expect(page.locator(".msg.agent").last()).toContainText("Turn 3");
    await expect(page.locator(".msg.agent").last()).toContainText("Also add tests");
    await expect(page.getByText(ANSWERING, { exact: true })).toBeVisible();
    await expect(bar(page)).toHaveCount(0);
    await expect(page.getByRole("region", { name: "Helpers", exact: true })).toContainText("1 helper working");
  } finally {
    await chat.remove();
  }
});

test("Off, nothing running: Stop and answer my message starts it at once, once, saying so", async ({ page, request, token }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const chat = await helperAtWork(page, request, token, "Off and Stop and answer");
  try {
    await setHub(request, token, false);
    await chat.change();
    await chat.send("Did it switch my model?");
    await expect(bar(page)).toContainText(HOLDS);
    await button(page, "Stop all agents").click();
    const which = page.getByRole("dialog");
    // No reply is running, so the dialog doesn't talk about stopping one, and says the helpers go on.
    await expect(which.getByText("Your message is waiting for the helpers to finish.")).toBeVisible();
    await expect(which.getByRole("button", { name: /^Stop and answer my message/ })).toContainText("Who your message is for answers it now. Helpers keep working.");
    await expect(which.getByRole("button", { name: /^Stop everything/ })).toContainText("Helpers keep working.");
    await which.getByRole("button", { name: /^Stop and answer my message/ }).click();
    await expect(which).toHaveCount(0);
    await expect(page.getByText(ANSWERING, { exact: true })).toBeVisible();
    await expect(page.locator(".msg.agent").last()).toContainText("Turn 2");
    await expect(page.locator(".msg.agent").last()).toContainText("Did it switch my model?");
    await expect(bar(page)).toHaveCount(0);
    await page.waitForTimeout(150);
    await expect(page.getByText("Turn 3", { exact: false })).toHaveCount(0);
    await expect(page.getByText(ANSWERING, { exact: true })).toHaveCount(1);
    await expect(page.getByRole("region", { name: "Helpers", exact: true })).toContainText("1 helper working");
    await noHorizontalOverflow(page);

    // The tap is used up: the next message waits, and the bar offers it again.
    await chat.send("And the docs?");
    await expect(bar(page)).toContainText(HOLDS);
    await bar(page).getByRole("button", { name: "Answer now", exact: true }).click();
    await expect(page.locator(".msg.agent").last()).toContainText("Turn 3");
    await expect(bar(page)).toHaveCount(0);
  } finally {
    await chat.remove();
  }
});

test("Off, nothing running: Stop everything, then another message: the bar is back with Answer now, and it goes", async ({ page, request, token }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const chat = await helperAtWork(page, request, token, "Off, Stop everything and on");
  try {
    await setHub(request, token, false);
    await chat.change();
    await chat.send("Did it switch my model?");
    await expect(bar(page)).toContainText(HOLDS);
    await button(page, "Stop all agents").click();
    const which = page.getByRole("dialog");
    await which.getByRole("button", { name: /^Stop everything/ }).click();
    await expect(which).toHaveCount(0);
    await expect(bar(page)).toHaveCount(0);
    await expect(page.getByText("Turn 2", { exact: false })).toHaveCount(0);

    await chat.send("And the docs?");
    await expect(bar(page)).toContainText(HOLDS);
    await expect(bar(page)).toContainText("Answer now uses the settings it started with.");
    const answer = bar(page).getByRole("button", { name: "Answer now", exact: true });
    await expect(answer).toBeVisible();
    await expect(page.locator(".chat-status")).toContainText("Finishing helpers before your new settings apply");
    await noHorizontalOverflow(page);
    await page.screenshot({ ...shot("keep-going-bar-after-stop.png"), animations: "disabled" });
    await answer.click();
    await expect(page.getByText(ANSWERING, { exact: true })).toBeVisible();
    await expect(page.locator(".msg.agent").last()).toContainText("Turn 2");
    await expect(page.locator(".msg.agent").last()).toContainText("And the docs?");
    await expect(bar(page)).toHaveCount(0);
    await expect(page.getByRole("region", { name: "Helpers", exact: true })).toContainText("1 helper working");
  } finally {
    await chat.remove();
  }
});

test("Off: Try again waits like any message, saying so, and Answer now on the bar sends it", async ({ page, request, token }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const chat = await helperAtWork(page, request, token, "Off and Try again", { failTurns: [2] });
  try {
    await setHub(request, token, false);
    await chat.change();
    await chat.send("Build the setup step");
    await bar(page).getByRole("button", { name: "Answer now", exact: true }).click();
    await expect(page.locator(".msg.agent").last()).toContainText("Mock failure");
    // Its helpers can run for hours: Try again is there all the same.
    await expect(page.locator(".chat-status")).toContainText("Finishing helpers before your new settings apply");
    await expect(bar(page)).toHaveCount(0);
    await button(page, "Try again").click();
    await expect(bar(page)).toContainText(HOLDS);
    await expect(page.getByText("Turn 3", { exact: false })).toHaveCount(0);
    await noHorizontalOverflow(page);
    await bar(page).getByRole("button", { name: "Answer now", exact: true }).click();
    await expect(page.locator(".msg.agent").last()).toContainText("Turn 3");
    await expect(bar(page)).toHaveCount(0);
    await expect(page.getByRole("region", { name: "Helpers", exact: true })).toContainText("1 helper working");
  } finally {
    await chat.remove();
  }
});

test("tighter permissions hold with it on or off, with no button; turning it on releases nothing", async ({ page, request, token }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const chat = await helperAtWork(page, request, token, "Off and permissions", {}, "full");
  const words = "Your message is waiting for its helpers to finish, so your permission change applies first.";
  try {
    await setHub(request, token, false);
    await chat.change("ask");
    await chat.send("Delete the old build folder");
    await expect(bar(page)).toHaveText(words);
    await expect(button(page, "Answer now")).toHaveCount(0);
    await expect(button(page, "Send now")).toHaveCount(0);
    await setHub(request, token, true);
    await page.waitForTimeout(150);
    await expect(bar(page)).toHaveText(words);
    await expect(button(page, "Answer now")).toHaveCount(0);
    await expect(page.getByText("Turn 2", { exact: false })).toHaveCount(0);
    await expect(page.locator(".msg-quiet")).toHaveCount(0);
    await noHorizontalOverflow(page);
  } finally {
    await chat.remove();
  }
});

test("with another machine picked: it reads and sets that machine's, says plainly it reaches no other, and an older hub says to update", async ({ page, request, token }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const linux = await otherMachine(page, token, { port: 8493 });
  // Both machines' live updates are played here (a real one closed while connecting trips Playwright's stand-in).
  await page.routeWebSocket("ws://127.0.0.1:5198/api/ws?**", pong);
  const cors = { "access-control-allow-origin": "http://127.0.0.1:5198", "access-control-allow-headers": "authorization, content-type", "access-control-allow-methods": "GET, POST, PUT, PATCH, DELETE, OPTIONS" };
  let there: { messagesFlow?: boolean } = { messagesFlow: false };
  const puts: unknown[] = [];
  await page.route(`${linux.base}/api/settings/hub`, async (route: Route) => {
    const req = route.request();
    if (req.method() === "OPTIONS") return route.fulfill({ status: 204, headers: cors });
    if (req.method() === "PUT") {
      puts.push(req.postDataJSON());
      there = { ...there, ...req.postDataJSON() };
    }
    return route.fulfill({ status: 200, headers: cors, contentType: "application/json", body: JSON.stringify({ machineName: "Linux box", agentsAcrossChats: false, pauseNearLimit: false, teamwork: { enabled: false, perReply: 1, skipAbovePercent: 80, helper: {} }, storage: { autoClean: true, lowSpaceGb: 15 }, ...there }) });
  });
  const home = async () => (await (await request.get(`${HUB}/api/settings/hub`, { headers: { authorization: `Bearer ${token}` } })).json()).messagesFlow;
  await page.goto("/#/settings/keep-going");
  // This machine's first, with the same plain line: it says so wherever there's more than one.
  await expect(theSwitch(page)).toBeChecked();
  const homeName = (await (await request.get(`${HUB}/api/state`, { headers: { authorization: `Bearer ${token}` } })).json()).hub.name as string;
  const NOT_OTHERS = "This doesn't reach your other machines. Each has its own: pick one at the top of Settings to change it there.";
  await expect(row(page).getByRole("note")).toHaveText(NOT_OTHERS);
  await expect(row(page).getByRole("status")).toHaveText(`Saves as you change it, for ${homeName} only.`);

  await page.getByRole("combobox", { name: "Machine", exact: true }).selectOption(linux.key);
  await expect(row(page).getByRole("note")).toHaveText(NOT_OTHERS);
  await expect(row(page).getByRole("status")).toHaveText("Saves as you change it, for Linux box only.");
  await expect(theSwitch(page)).not.toBeChecked();
  await noHorizontalOverflow(page);
  await row(page).scrollIntoViewIfNeeded();
  await page.screenshot({ ...shot("keep-going-other-machine.png"), animations: "disabled" });

  // Set there, not here.
  await theSwitch(page).click();
  await expect(theSwitch(page)).toBeChecked();
  await expect.poll(() => puts.length).toBe(1);
  expect(puts[0]).toEqual({ messagesFlow: true });
  expect(await home()).toBe(true);
  // Changed there from another device: this one hears it from that machine.
  linux.send({ t: "hub", hub: { ...linux.hub, messagesFlow: false } });
  await expect(theSwitch(page)).not.toBeChecked();

  // A machine whose hub is older: no switch that would do nothing.
  there = {};
  await page.getByRole("combobox", { name: "Machine", exact: true }).selectOption("");
  await expect(theSwitch(page)).toBeChecked();
  await page.getByRole("combobox", { name: "Machine", exact: true }).selectOption(linux.key);
  await expect(row(page)).toContainText("Update Crosstalk on Linux box to choose this.");
  await expect(row(page).getByRole("checkbox")).toHaveCount(0);
  await noHorizontalOverflow(page);

  // That machine is updated and comes back, with the setting: the words go by themselves, with Settings still open.
  there = { messagesFlow: false };
  const before = linux.sockets();
  linux.refuse(true);
  await expect.poll(() => linux.sockets(), { timeout: 10_000 }).toBeGreaterThan(before);
  linux.refuse(false);
  await expect(theSwitch(page)).not.toBeChecked({ timeout: 15_000 });
  await expect(row(page)).not.toContainText("Update Crosstalk");
  await expect(row(page).getByRole("status")).toHaveText("Saves as you change it, for Linux box only.");
});
