// A service moved between Crosstalk's own agent and OpenCode (Providers.switchServiceAgent): its spending limit and what
// counts against it go with it (hub/src/spend.ts budgetMoved). Nothing here reaches a service: the address can't resolve,
// and nothing asks it for models. The move made a new account id and limits are kept by account, so one tap used to lift
// a limit that was already reached.
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AccountSpend, Provider } from "@crosstalk/shared";
import { App } from "../src/app";
import type { PushNote } from "../src/push";
import "../src/providers/all";

const BASE = "https://service.invalid";
const MODEL = "some-model";
const FULL = "Refuseless reached its $5.00 limit, so this reply didn't start.";
const FAKE_OPENCODE = join(import.meta.dir, "fixtures", "fake-opencode-acp");

const open: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of open.splice(0)) await close();
});

function hub() {
  const dir = mkdtempSync(join(tmpdir(), "ct-move-"));
  const app = new App({ dbPath: ":memory:", config: { port: 0, host: "127.0.0.1", publicUrl: null, workspaceRoot: dir, maxHopsDefault: 6 } });
  const which = app.providers.which.bind(app.providers);
  app.providers.which = (p) => (p === "opencode" ? FAKE_OPENCODE : which(p));
  app.providers.models = async (provider) => ({ provider, live: true, error: null, models: [] });
  const pushes: PushNote[] = [];
  app.push.send = async (note) => {
    pushes.push(note);
    return { sent: 0, failed: 0 };
  };
  const add = (provider: Provider) => app.providers.setEndpointAccount(provider, { label: "Refuseless", baseUrl: BASE, apiKey: "test-key", models: [MODEL], contextWindow: 1_048_576, protocol: "chat" });
  const spent = (provider: Provider, account: string, costUsd: number, at?: number) => app.spend.record({ source: "ask", provider, account, roomId: "r1", chatName: "Chat", askId: "a1", model: MODEL, inputTokens: 1, outputTokens: 1, cachedTokens: 0, costUsd, basis: "estimated", ...(at ? { at } : {}) });
  const row = (provider: Provider, account: string) => app.spend.accounts().find((a) => a.provider === provider && a.account === account) as AccountSpend;
  const chatOn = (provider: Provider, account: string) => app.chats.create({ provider, name: "Stays", cwd: dir, account, model: MODEL } as never);
  open.push(async () => {
    await app.shutdown();
    rmSync(dir, { recursive: true, force: true });
  });
  return { app, dir, add, spent, row, chatOn, pushes };
}

describe("the old row goes", () => {
  test("a limit already reached stays reached, moving back too, with the month's figures on the new row and no (removed) card", async () => {
    const t = hub();
    const old = t.add("builtin");
    t.app.spend.setBudget("builtin", old.id, { limitUsd: 5 });
    t.spent("builtin", old.id, 6);
    expect(t.app.spend.checkBudget("builtin", old.id)).toBe(FULL);
    expect(t.pushes.map((p) => p.title)).toEqual(["Spending limit reached"]);

    const moved = t.app.providers.switchServiceAgent("builtin", old.id, "opencode");
    expect(moved.id).not.toBe(old.id);
    expect(t.app.providers.endpointOf("builtin", old.id)).toBeNull();
    expect(t.app.spend.checkBudget("opencode", moved.id)).toBe(FULL);
    expect(t.row("opencode", moved.id).budget).toMatchObject({ limitUsd: 5, period: "month", usedUsd: 6, state: "stopped" });
    expect(t.row("opencode", moved.id).month.usd).toBe(6);
    expect(t.row("builtin", old.id)).toBeUndefined();

    // A chat on the new row is refused as the old one was, before anything goes to the service.
    const room = t.chatOn("opencode", moved.id);
    t.app.engine.postHumanMessage(room.id, "Hello", "Phone");
    await t.app.engine.whenIdle();
    expect(t.app.store.listMessages(room.id).at(-1)).toMatchObject({ authorKind: "agent", status: "error", text: FULL });
    await t.app.deleteRoom(room.id);

    const back = t.app.providers.switchServiceAgent("opencode", moved.id, "builtin");
    expect(t.app.spend.checkBudget("builtin", back.id)).toBe(FULL);
    expect(t.app.spend.accounts().map((a) => a.account)).toEqual([back.id]);
    // What it was told stays told: the limit it reached doesn't push again from the new row.
    t.spent("builtin", back.id, 1);
    expect(t.pushes).toHaveLength(1);
  });

  test("raising it keeps the count, and removing it still works", () => {
    const t = hub();
    const old = t.add("builtin");
    t.app.spend.setBudget("builtin", old.id, { limitUsd: 5 });
    t.spent("builtin", old.id, 6);
    const moved = t.app.providers.switchServiceAgent("builtin", old.id, "opencode");
    t.app.spend.setBudget("opencode", moved.id, { limitUsd: 10 });
    expect(t.app.spend.checkBudget("opencode", moved.id)).toBeNull();
    expect(t.row("opencode", moved.id).budget).toMatchObject({ limitUsd: 10, usedUsd: 6, state: "ok" });
    t.spent("opencode", moved.id, 4);
    expect(t.app.spend.checkBudget("opencode", moved.id)).not.toBeNull();
    t.app.spend.setBudget("opencode", moved.id, { limitUsd: null });
    expect(t.app.spend.checkBudget("opencode", moved.id)).toBeNull();
    expect(t.row("opencode", moved.id).budget).toBeNull();
  });

  test("a total limit keeps its start, so what came before it still doesn't count; a monthly one counts only this month", () => {
    const t = hub();
    const old = t.add("builtin");
    t.spent("builtin", old.id, 3, Date.now() - 60_000);
    const since = t.app.spend.setBudget("builtin", old.id, { limitUsd: 5, period: "total" }).budget!.since;
    t.spent("builtin", old.id, 1);
    const moved = t.app.providers.switchServiceAgent("builtin", old.id, "opencode");
    expect(t.row("opencode", moved.id).budget).toMatchObject({ period: "total", since, usedUsd: 1, limitUsd: 5 });
    expect(t.row("opencode", moved.id).total.usd).toBe(4);

    const later = hub();
    const first = later.add("builtin");
    later.spent("builtin", first.id, 9, Date.now() - 45 * 24 * 3600_000);
    later.app.spend.setBudget("builtin", first.id, { limitUsd: 5 });
    const there = later.app.providers.switchServiceAgent("builtin", first.id, "opencode");
    expect(later.row("opencode", there.id).budget).toMatchObject({ usedUsd: 0, state: "ok" });
    expect(later.row("opencode", there.id).total.usd).toBe(9);
  });

  test("no limit: none appears, and what it spent still follows the service", () => {
    const t = hub();
    const old = t.add("builtin");
    t.spent("builtin", old.id, 2);
    const moved = t.app.providers.switchServiceAgent("builtin", old.id, "opencode");
    expect(t.row("opencode", moved.id)).toMatchObject({ budget: null, month: { usd: 2 } });
    expect(t.row("builtin", old.id)).toBeUndefined();
    expect(t.app.store.kvGet("spend.budgets") ?? "{}").toBe("{}");
  });
});

describe("the old row stays for its chats", () => {
  test("one count across both rows: either side's spend counts for both, and they stop together, with one push for each threshold", () => {
    const t = hub();
    const old = t.add("builtin");
    t.chatOn("builtin", old.id);
    t.app.spend.setBudget("builtin", old.id, { limitUsd: 5 });
    t.spent("builtin", old.id, 2);
    const moved = t.app.providers.switchServiceAgent("builtin", old.id, "opencode");
    expect(t.app.providers.endpointOf("builtin", old.id)).not.toBeNull();
    expect(t.app.spend.checkBudget("builtin", old.id)).toBeNull();
    expect(t.app.spend.checkBudget("opencode", moved.id)).toBeNull();
    // Nothing is rewritten: each row keeps the figures of the replies it ran.
    t.spent("opencode", moved.id, 2);
    expect(t.pushes.map((p) => p.title)).toEqual(["Nearing a spending limit"]);
    expect(t.row("builtin", old.id).budget).toMatchObject({ usedUsd: 4, state: "warn" });
    t.spent("builtin", old.id, 1);
    expect(t.pushes.map((p) => p.title)).toEqual(["Nearing a spending limit", "Spending limit reached"]);
    expect(t.row("builtin", old.id)).toMatchObject({ month: { usd: 3 }, budget: { usedUsd: 5, state: "stopped" } });
    expect(t.row("opencode", moved.id)).toMatchObject({ month: { usd: 2 }, budget: { usedUsd: 5, state: "stopped" } });
    expect(t.app.spend.checkBudget("builtin", old.id)).toBe(FULL);
    expect(t.app.spend.checkBudget("opencode", moved.id)).toBe(FULL);
    // A reply on the other row doesn't say it again.
    t.spent("opencode", moved.id, 1);
    expect(t.pushes).toHaveLength(2);
  });

  test("raising one row's limit keeps the shared count, and the other row keeps the limit it has", () => {
    const t = hub();
    const old = t.add("builtin");
    t.chatOn("builtin", old.id);
    t.app.spend.setBudget("builtin", old.id, { limitUsd: 5 });
    t.spent("builtin", old.id, 6);
    const moved = t.app.providers.switchServiceAgent("builtin", old.id, "opencode");
    expect(t.app.spend.checkBudget("opencode", moved.id)).toBe(FULL);
    t.app.spend.setBudget("opencode", moved.id, { limitUsd: 10 });
    expect(t.row("opencode", moved.id).budget).toMatchObject({ limitUsd: 10, usedUsd: 6, state: "ok" });
    expect(t.app.spend.checkBudget("builtin", old.id)).toBe(FULL);
    // The old row still counts what the new one spends.
    t.spent("opencode", moved.id, 1);
    expect(t.row("builtin", old.id).budget).toMatchObject({ limitUsd: 5, usedUsd: 7 });
    expect(t.row("opencode", moved.id).budget).toMatchObject({ limitUsd: 10, usedUsd: 7 });
  });

  test("moving back onto the row that stayed hands over what was spent and keeps the limit", () => {
    const t = hub();
    const old = t.add("builtin");
    t.chatOn("builtin", old.id);
    t.app.spend.setBudget("builtin", old.id, { limitUsd: 5 });
    t.spent("builtin", old.id, 1);
    const moved = t.app.providers.switchServiceAgent("builtin", old.id, "opencode");
    t.spent("opencode", moved.id, 3);
    const back = t.app.providers.switchServiceAgent("opencode", moved.id, "builtin");
    expect(back.id).toBe(old.id);
    expect(t.app.providers.endpointOf("opencode", moved.id)).toBeNull();
    expect(t.row("builtin", old.id)).toMatchObject({ month: { usd: 4 }, budget: { limitUsd: 5, usedUsd: 4, state: "warn" } });
    expect(t.row("opencode", moved.id)).toBeUndefined();
  });
});

describe("the other agent already has a row at that address", () => {
  test("its own limit stays and counts only its own spend; the old row's history stays where it was", () => {
    const t = hub();
    const old = t.add("builtin");
    const there = t.add("opencode");
    t.app.spend.setBudget("builtin", old.id, { limitUsd: 5 });
    t.spent("builtin", old.id, 6);
    t.app.spend.setBudget("opencode", there.id, { limitUsd: 50 });
    t.spent("opencode", there.id, 1);
    const moved = t.app.providers.switchServiceAgent("builtin", old.id, "opencode");
    expect(moved.id).toBe(there.id);
    expect(t.row("opencode", there.id).budget).toMatchObject({ limitUsd: 50, usedUsd: 1, state: "ok" });
    expect(t.app.spend.checkBudget("opencode", there.id)).toBeNull();
    expect(t.row("builtin", old.id)).toMatchObject({ label: "Crosstalk agent (removed)", budget: null, total: { usd: 6 } });
  });

  test("with no limit of its own, it takes the service's", () => {
    const t = hub();
    const old = t.add("builtin");
    const there = t.add("opencode");
    t.app.spend.setBudget("builtin", old.id, { limitUsd: 5 });
    t.spent("builtin", old.id, 4);
    t.spent("opencode", there.id, 2);
    t.app.providers.switchServiceAgent("builtin", old.id, "opencode");
    expect(t.row("opencode", there.id)).toMatchObject({ month: { usd: 6 }, budget: { limitUsd: 5, usedUsd: 6, state: "stopped" } });
  });
});
