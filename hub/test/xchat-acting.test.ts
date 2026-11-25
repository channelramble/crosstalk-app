import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PermissionMode } from "@crosstalk/shared";
import { App } from "../src/app";
import "../src/providers/all";
import { resetFailureLimits, startServer } from "../src/server";
import { newId } from "../src/util/ids";

// Another machine's agents and chats here that act without asking. The machine that sends asks its own user first, but
// that's its word: a machine that was broken into, or runs a changed Crosstalk, wouldn't ask. So this machine decides
// for itself: such a chat takes no message from another machine's agents, and a chat they start here asks first,
// unless this machine's own settings say otherwise.
const cleanups: (() => unknown)[] = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
});

async function linked() {
  const dir = mkdtempSync(join(tmpdir(), "crosstalk-acting-"));
  const app = new App({ dbPath: ":memory:", config: { port: 0, host: "127.0.0.1", publicUrl: null, workspaceRoot: dir, maxHopsDefault: 6 } });
  const server = startServer(app);
  resetFailureLimits();
  cleanups.push(async () => {
    resetFailureLimits();
    server.stop(true);
    await app.engine.shutdown();
    app.store.close();
    rmSync(dir, { recursive: true, force: true });
  });
  app.setHubSettings({ agentsAcrossChats: true });
  // The other machine's limited sign-in here, as a link leaves it.
  const code = await app.auth.createPairingCode(60_000, { scope: "peer", hubId: "h_other123" });
  const peer = (await app.auth.pair(code.code, "Linux box (hub)", "Crosstalk hub"))!;
  app.store.kvSet("machines.links", JSON.stringify([{ id: "h_other123", name: "Linux box", url: "https://box.example.ts.net", addedAt: Date.now(), token: "x", deviceId: "d_x", scope: "peer", relayId: null, inboundDeviceId: peer.device.id, agents: "two-way", error: null }]));
  const headers = { authorization: `Bearer ${peer.token}`, "content-type": "application/json" };
  const base = `http://127.0.0.1:${server.port}`;
  const chat = (name: string, permissionMode: PermissionMode) => {
    const now = Date.now();
    const room = { id: newId("r"), name, cwd: dir, mode: "direct", leadMemberId: null, maxHops: 0, rounds: 1, parallel: false, createdAt: now, updatedAt: now, archived: false };
    app.store.insertRoom(room as never);
    app.store.insertChat({ roomId: room.id, provider: "claude", origin: "web", localId: null } as never);
    app.store.insertMember({ id: newId("mb"), roomId: room.id, handle: "agent", provider: "mock", model: null, role: "", permissionMode, status: "idle", statusDetail: null, config: { delayMs: 20, reply: "done" }, createdAt: now, position: 0 } as never);
    return room;
  };
  let n = 0;
  const message = (roomId: string) =>
    fetch(`${base}/api/machines/chats/${roomId}/messages`, { method: "POST", headers, body: JSON.stringify({ text: "Deploy it now", requestId: `r${++n}`, hop: 1, from: { chatId: "c1", chatName: "Planning", agent: "Claude Code" } }) });
  return { app, chat, message };
}

test("a chat that acts without asking takes no message from another machine's agents; one that asks first does", async () => {
  const { app, chat, message } = await linked();
  const careful = chat("Notes", "ask");
  for (const mode of ["edits", "auto", "full"] as const) {
    const acting = chat(`Deploys (${mode})`, mode);
    const refused = await message(acting.id);
    expect([mode, refused.status]).toEqual([mode, 403]);
    const body = (await refused.json()) as { error: string; code: string };
    expect(body.code).toBe("acts_without_asking");
    expect(body.error).toContain("acts without asking");
    expect(body.error).toContain("Settings → Agents together");
    // Nothing was written into the chat, and its agent never started.
    expect(app.store.listMessages(acting.id, { limit: 10 })).toEqual([]);
    expect(app.store.listTurns(acting.id, 10)).toEqual([]);
  }
  const taken = await message(careful.id);
  expect(taken.status).toBe(200);
  await app.engine.whenIdle();
  expect(app.store.listMessages(careful.id, { limit: 10 }).some((m) => m.text.includes("Deploy it now"))).toBe(true);
});

test("turned on in this machine's own settings, they can; it's off until then, and the other machine can't turn it on", async () => {
  const { app, chat, message } = await linked();
  const acting = chat("Deploys", "full");
  expect(app.hubSettings().agentsFromMachinesAct).toBeFalsy();
  expect((await message(acting.id)).status).toBe(403);
  // Nothing in what the other machine sends changes that.
  expect(app.setHubSettings({ agentsFromMachinesAct: true }).agentsFromMachinesAct).toBe(true);
  const taken = await message(acting.id);
  expect(taken.status).toBe(200);
  await app.engine.whenIdle();
  expect(app.store.listTurns(acting.id, 10).length).toBeGreaterThan(0);
  // Off again is saved as nothing: off is what an unsaved setting means.
  expect(app.setHubSettings({ agentsFromMachinesAct: false }).agentsFromMachinesAct).toBeUndefined();
  expect((await message(acting.id)).status).toBe(403);
});
