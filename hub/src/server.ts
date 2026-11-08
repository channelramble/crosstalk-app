import { existsSync, statSync } from "node:fs";
import { homedir, userInfo } from "node:os";
import { join, normalize, resolve, extname, dirname } from "node:path";
import type { ServerWebSocket } from "bun";
import { isNoRewindAgent, MESSAGE_MAX, PROVIDER_INFO, memberAccount, messageTooLongWords, type ClientEvent, type Device, type Provider, type ServerEvent } from "@crosstalk/shared";
import type { App } from "./app";
import { HttpError, previewActivity } from "./engine/engine";
import { tokenFromRequest } from "./auth";
import { logger } from "./util/log";
import { cutText } from "./util/text";
import { startInternalServer } from "./internal-server";
import { embeddedAsset } from "./web-assets";
import { attachmentText, folderFile, getUpload, listFolder, projectFile, saveFolderFile, saveUpload, saveZipFolder } from "./uploads";
import { NEW_CHAT } from "./chats";
import { dropForkCopies, duplicateChat, exportChat, markDuplicated, receiveDuplicate } from "./duplicate";
import { pinChat } from "./pins";
import { json, peerRoute, route, type Ctx, type Handler, type Route } from "./routes";
import { askRoutes } from "./asks";
import { spendRoutes } from "./spend";
import { serviceRoutes } from "./services";
import { searchRoutes } from "./search";
import { bookmarkRoutes } from "./bookmarks";
import { localModelRoutes } from "./localModels";
import { templateRoutes } from "./templates";
import { macFixCommand } from "./mac";
import { directLocal, handleSetupInternal, setupGuideResponse, setupRoutes } from "./setup";
import { isPersonDevice, signInRoutes } from "./signin";

const log = logger("http");

interface WsData {
  device: Device;
  /** The protocol the app speaks (PROTOCOL_VERSION; 1 for apps that don't say). */
  v: number;
  off?: () => void;
  visible?: boolean;
  /** Older apps: when each step was last sent whole, and the send waiting to catch up (see legacyStep). */
  steps?: Map<string, { at: number; timer: ReturnType<typeof setTimeout> | null }>;
}

/** An older app gets a step whole at most this often while it streams (it can't add deltas to what it has). */
const LEGACY_STEP_MS = 1000;

/** The protocol version a request says it speaks (?v=), 1 when it doesn't. */
function protocolOf(url: URL): number {
  const v = Number(url.searchParams.get("v") || 1);
  return Number.isFinite(v) && v >= 1 ? Math.floor(v) : 1;
}

/** Which linked machine's hub a request comes from (other machines' agents only; people's devices don't use these). */
function xcaller(app: App, device: Device): { hubId: string; machine: string } {
  const hub = app.machines.hubOfDevice(device);
  if (!hub) throw new HttpError(403, "Only linked machines' agents can use this.", "not_linked");
  return { hubId: hub.id, machine: hub.name };
}

export function buildRoutes(app: App): Route[] {
  const P = (p: string) => p as Provider;
  const core: Route[] = [
    route("GET", "/api/state", ({ device }) => app.snapshot(device)),
    route("GET", "/api/rooms/:id/history", async ({ params, url }) => {
      const room = app.store.getRoom(params.id);
      if (!room) throw new HttpError(404, "room not found");
      const before = Number(url.searchParams.get("before") || 0) || undefined;
      // A chat that continues a conversation from the agent's own app brings in what was said there since. Not waited
      // for (reading a Codex thread can take seconds): what it brings in goes out as live messages.
      if (room.chat && !before) void app.chats.sync(room.id).catch((e) => log.debug(`sync ${room.name}: ${e instanceof Error ? e.message : e}`));
      const limit = Number(url.searchParams.get("limit") || 80);
      const messages = app.store.listMessages(params.id, { beforeSeq: before, limit });
      const turnIds = [...new Set(messages.map((m) => m.turnId).filter(Boolean) as string[])];
      const turns = app.store.listTurns(params.id, 400).filter((t) => turnIds.includes(t.id) || t.status === "queued" || t.status === "running");
      const running = new Set(app.engine.runningTurns(params.id).map((t) => t.id));
      // Newer apps get finished steps' long details shortened (the rest comes when a step is opened); older ones whole.
      const activities = app.store.listActivities(params.id, turnIds);
      return {
        room,
        messages,
        turns: turns.map((t) => app.engine.liveTurn(t)),
        activities: protocolOf(url) >= 2 ? activities.map((a) => previewActivity(a, a.status === "running" && running.has(a.turnId))) : activities,
        approvals: app.store.listApprovals(params.id, 50),
        tasks: app.engine.tasksIn(params.id),
        totals: app.store.roomTokenTotals(params.id),
        hasMore: messages.length > 0 && messages[0].seq > 1 && messages.length >= Math.min(limit, 500),
      };
    }),
    // A step whole: its detail may have come shortened (Activity.detailLength), or still be streaming.
    route("GET", "/api/activities/:id", ({ params }) => {
      const a = app.engine.liveActivity(params.id) ?? app.store.getActivity(params.id);
      if (!a) throw new HttpError(404, "That step is gone (its reply was taken back).");
      return a;
    }),
    route("POST", "/api/rooms", async ({ body }) => app.createRoom(await body())),
    route("PATCH", "/api/rooms/:id", async ({ params, body }) => app.updateRoom(params.id, await body())),
    route("DELETE", "/api/rooms/:id", async ({ params }) => {
      await app.deleteRoom(params.id);
      return { ok: true };
    }),
    route("POST", "/api/rooms/:id/messages", async ({ params, body, device }) => {
      const b = await body();
      const room = app.store.getRoom(params.id);
      if (!room) throw new HttpError(404, "room not found");
      const text = (String(b.text ?? "").trim() + attachmentText(room, b.attachments)).trim();
      if (!text) throw new HttpError(400, "empty message");
      if (text.length > MESSAGE_MAX) throw new HttpError(413, messageTooLongWords(text.length));
      // A new chat takes its name from its first message.
      if (room.chat && room.name === NEW_CHAT && String(b.text ?? "").trim()) {
        app.updateRoom(room.id, { name: cutText(String(b.text).replace(/\s+/g, " ").trim(), 60) });
      }
      return app.engine.postHumanMessage(params.id, text, device.name, String(b.text ?? ""));
    }),
    route("POST", "/api/rooms/:id/uploads", async ({ params, req, url }) => {
      const room = app.store.getRoom(params.id);
      if (!room) throw new HttpError(404, "room not found");
      const folder = url.searchParams.get("folder");
      if (folder) return saveFolderFile(room, req, folder, url.searchParams.get("path") ?? "");
      if (url.searchParams.get("unzip") === "1") return saveZipFolder(room, req, url.searchParams.get("name") ?? "folder.zip");
      return saveUpload(room, req, url.searchParams.get("name") ?? "file");
    }),
    // ---- Chats: one agent each, including conversations from the agents' own apps on this machine ----
    route("POST", "/api/chats", async ({ body }) => app.chats.create(await body())),
    // A group chat: two or more agents, each with its own account, model and effort.
    route("POST", "/api/chats/group", async ({ body }) => app.chats.createGroup(await body())),
    route("GET", "/api/chats/local", ({ url }) => app.chats.localSessions(url.searchParams.get("provider"))),
    route("POST", "/api/chats/open", async ({ body }) => {
      const b = await body();
      return app.chats.open(b.provider, String(b.id ?? ""));
    }),
    // Duplicate chat (duplicate.ts): on this machine in one go; to another machine, the app reads the chat here
    // (export), has that machine's hub make the copy (POST /api/chats/duplicate), then notes it here (duplicated).
    route("POST", "/api/chats/:id/duplicate", async ({ params, body }) => duplicateChat(app, params.id, await body())),
    route("GET", "/api/chats/:id/export", ({ params }) => exportChat(app, params.id)),
    route("POST", "/api/chats/:id/duplicated", async ({ params, body }) => markDuplicated(app, params.id, await body())),
    route("POST", "/api/chats/duplicate", async ({ body }) => receiveDuplicate(app, await body())),
    // Older apps' "Continue in a copy" (before Duplicate chat): the chat itself goes on in a fork of its session.
    route("POST", "/api/chats/:id/copy", async ({ params }) => {
      await app.chats.continueInCopy(params.id);
      return { ok: true };
    }),
    // ---- Settings → Defaults for new rooms and agents ----
    // Folders a new chat, group chat or template can work in: the chats' own and the workspaces folder's.
    route("GET", "/api/folders", () => app.folders()),
    route("GET", "/api/settings/hub", () => app.hubSettings()),
    route("PUT", "/api/settings/hub", async ({ body }) => app.setHubSettings(await body())),
    route("GET", "/api/settings/defaults", () => app.defaults()),
    route("PATCH", "/api/settings/defaults/:provider", async ({ params, body }) => app.setAgentDefaults(params.provider, await body())),
    // ---- Settings → Storage ----
    route("GET", "/api/storage", ({ url }) => app.storage.report(url.searchParams.get("rescan") === "1")),
    route("POST", "/api/storage/clean", () => {
      void app.storage.autoClean(true);
      return app.storage.report();
    }),
    route("POST", "/api/storage/delete", async ({ body }) => app.storage.remove(((await body()) as { ids?: unknown } | null)?.ids)),
    route("PUT", "/api/settings/defaults", async ({ body }) => app.setDefaults(await body())),
    // ---- Computers the agents can run commands on ----
    route("GET", "/api/computers", () => app.computers.statuses()),
    route("POST", "/api/computers/invite", ({ url }) => {
      const { token, expiresAt } = app.computers.invite();
      const hub = (app.config.publicUrl || url.origin).replace(/\/+$/, "");
      return {
        invite: token,
        command: `curl -fsSL '${hub}/api/computers/claim/${token}/script' | sh`,
        // Windows: PowerShell as administrator (its SSH server has to be turned on).
        windowsCommand: `irm '${hub}/api/computers/claim/${token}/ps1' | iex`,
        expiresAt,
      };
    }),
    // The connect dialog follows its own invite, so reconnecting a computer that's already listed still completes.
    route("GET", "/api/computers/invites/:token", ({ params }) => app.computers.inviteStatus(params.token)),
    route("POST", "/api/computers/:name/test", ({ params }) => app.computers.test(params.name)),
    route("DELETE", "/api/computers/:name", ({ params }) => app.computers.remove(params.name)),
    route("GET", "/api/rooms/:id/files", ({ params, url }) => {
      const room = app.store.getRoom(params.id);
      if (!room) throw new HttpError(404, "room not found");
      // Downloads only: never render project content as a page on the hub's origin.
      const f = projectFile(room, url.searchParams.get("path") ?? "");
      return new Response(Bun.file(f.path), { headers: {
        "content-type": "application/octet-stream",
        "content-disposition": `attachment; filename*=UTF-8''${encodeURIComponent(f.name)}`,
        "content-length": String(f.size),
        "x-content-type-options": "nosniff",
        "cache-control": "private, no-store",
      } });
    }),
    route("GET", "/api/rooms/:id/folders/:folder/:name", ({ params, url }) => {
      const room = app.store.getRoom(params.id);
      if (!room) throw new HttpError(404, "room not found");
      const rel = url.searchParams.get("file");
      if (!rel) return listFolder(room, params.folder, params.name, Number(url.searchParams.get("offset") ?? 0));
      // Downloads only: never render uploaded content as a page on the hub's origin.
      const f = folderFile(room, params.folder, params.name, rel);
      return new Response(Bun.file(f.path), { headers: {
        "content-type": "application/octet-stream",
        "content-disposition": `attachment; filename*=UTF-8''${encodeURIComponent(f.name)}`,
        "x-content-type-options": "nosniff",
        "cache-control": "private, no-store",
      } });
    }),
    route("GET", "/api/rooms/:id/uploads/:filename", ({ params }) => {
      const room = app.store.getRoom(params.id);
      if (!room) throw new HttpError(404, "room not found");
      const upload = getUpload(room, params.filename);
      return new Response(Bun.file(upload.path), { headers: {
        "content-type": upload.mimeType,
        // filename* carries any name safely (a raw non-ASCII or quoted name would break the header).
        "content-disposition": `${upload.mimeType.startsWith("image/") ? "inline" : "attachment"}; filename*=UTF-8''${encodeURIComponent(upload.name)}`,
        "x-content-type-options": "nosniff",
        "cache-control": "private, no-store",
      } });
    }),
    route("POST", "/api/rooms/:id/stop", async ({ params, body }) => {
      const b = await body().catch(() => ({}));
      // keepWaiting: "Stop and answer my message" (the messages you sent meanwhile are answered next).
      await app.engine.stop(params.id, b.memberId || undefined, { keepWaiting: b.keepWaiting === true });
      return { ok: true };
    }),
    // "Try again" on a failed reply, and "Answer now" on a message nothing answered (see Engine.retry).
    // In a group chat, `memberId` says whose failed reply to try again (without it: your newest message is answered).
    // `currentSettings`: it's "Answer now", as on the send-now route.
    route("POST", "/api/rooms/:id/retry", async ({ params, body }) => {
      if (!app.store.getRoom(params.id)) throw new HttpError(404, "room not found");
      const b = ((await body().catch(() => ({}))) ?? {}) as { memberId?: unknown; currentSettings?: unknown };
      return { turn: app.engine.retry(params.id, typeof b.memberId === "string" && b.memberId ? b.memberId : null, { currentSettings: b.currentSettings === true }) };
    }),
    // A chat waiting for a usage limit to reset (Turn.wait): carry on now, or leave it as a failed reply with Try again.
    // In a group chat, `memberId` says which agent's wait.
    route("POST", "/api/rooms/:id/limit-wait/now", async ({ params, body }) => {
      if (!app.store.getRoom(params.id)) throw new HttpError(404, "room not found");
      const b = ((await body().catch(() => ({}))) ?? {}) as { memberId?: unknown };
      return { turn: app.engine.tryNow(params.id, typeof b.memberId === "string" && b.memberId ? b.memberId : null) };
    }),
    route("POST", "/api/rooms/:id/limit-wait/cancel", async ({ params, body }) => {
      if (!app.store.getRoom(params.id)) throw new HttpError(404, "room not found");
      const b = ((await body().catch(() => ({}))) ?? {}) as { memberId?: unknown };
      return { turn: app.engine.dontWait(params.id, typeof b.memberId === "string" && b.memberId ? b.memberId : null) };
    }),
    // You've read a chat up to `at` (on any device): the later of that and what was read already is kept, for all of them.
    route("POST", "/api/rooms/:id/read", async ({ params, body }) => {
      const b = ((await body().catch(() => ({}))) ?? {}) as { at?: unknown };
      const at = typeof b.at === "number" && Number.isFinite(b.at) && b.at > 0 ? Math.min(Math.floor(b.at), Date.now()) : Date.now();
      const room = app.store.markRead(params.id, at);
      if (!room) throw new HttpError(404, "room not found");
      app.bus.emit({ t: "room", room });
      return room;
    }),
    // Pin or unpin a chat, or move it among the pinned ones (pins.ts): the same on every device, through `room` events.
    route("POST", "/api/rooms/:id/pin", async ({ params, body }) => pinChat(app, params.id, await body().catch(() => ({})))),
    route("POST", "/api/rooms/:id/members", async ({ params, body }) => app.addMember(params.id, await body())),
    route("PATCH", "/api/members/:id", async ({ params, body, device }) => app.updateMember(params.id, await body(), device?.name)),
    // What's always allowed in a chat ("Always allow"), and taking one back.
    route("GET", "/api/members/:id/always", ({ params }) => app.alwaysAllowed(params.id)),
    route("DELETE", "/api/members/:id/always", async ({ params, body }) => app.removeAlwaysAllowed(params.id, ((await body()) as { id?: unknown } | null)?.id)),
    route("DELETE", "/api/members/:id", async ({ params }) => {
      await app.removeMember(params.id);
      return { ok: true };
    }),
    // Edit or unsend one of your messages in a chat (rewinds the agent if it already read it). `ifUnread`: the app asked
    // once, for a message the agent hadn't read; one it has read by now (a rewind) is refused, to be asked about again.
    route("PATCH", "/api/messages/:id", async ({ params, body, device }) => {
      const b = await body();
      if (typeof b.text !== "string") throw new HttpError(400, "Send the new text");
      if (app.store.getMessage(params.id)?.via) throw new HttpError(400, "Messages from other chats can't be edited");
      if (b.ifUnread === true) stillUnread(app, params.id);
      return app.reviseMessage(params.id, b.text, device.name);
    }),
    route("DELETE", "/api/messages/:id", async ({ params, body, device }) => {
      // A message from another chat can be taken back only before the agent reads it (its sender then hears so).
      const m = app.store.getMessage(params.id);
      if (m?.via) {
        const member = app.store.listMembers(m.roomId)[0];
        if (member && app.store.messageSeq(m.id) <= app.store.getLastSeen(member.id).seq) throw new HttpError(409, `${PROVIDER_INFO[member.provider]?.name ?? "The agent"} already read this message`);
      }
      const b = ((await body().catch(() => ({}))) ?? {}) as { ifUnread?: unknown };
      if (b.ifUnread === true) stillUnread(app, params.id);
      return app.reviseMessage(params.id, null, device.name);
    }),
    // Back to just after one of the agent's replies: everything after it leaves the chat, and the agent forgets it.
    route("POST", "/api/messages/:id/rewind", async ({ params, device }) => app.rewindTo(params.id, device.name)),
    // "Send now": a message waiting behind a chat's running reply goes into that reply. In a group chat, `memberId` says
    // whose reply (two can work at once). Not sent, it says why (SendNowResult). `currentSettings`: "Answer now" while new
    // settings wait for the agent's helpers, which only holds a message with "Keep going while helpers work" off: with it
    // on the message has gone by itself, and this is ignored.
    route("POST", "/api/rooms/:id/send-now", async ({ params, body }) => {
      const b = await body().catch(() => null);
      return app.engine.sendNowWhy(params.id, memberIdOf(b), { currentSettings: (b as { currentSettings?: unknown } | null)?.currentSettings === true });
    }),
    // "Read it now": the step the agent is on stops, so it reads what "Send now" handed over at once.
    route("POST", "/api/rooms/:id/read-now", async ({ params, body }) => ({ reading: await app.engine.readNow(params.id, memberIdOf(await body().catch(() => null))) })),
    route("POST", "/api/members/:id/reset", async ({ params }) => {
      const m = app.store.getMember(params.id);
      if (!m) throw new HttpError(404, "agent not found");
      // A duplicated chat that hadn't forked yet won't: the transcript copied for its fork goes.
      dropForkCopies(app, m.id);
      await app.engine.resetSession(m);
      return { ok: true };
    }),
    route("POST", "/api/approvals/:id", async ({ params, body, device }) => {
      const b = await body();
      if (!["approve", "approve_always", "deny"].includes(b.decision)) throw new HttpError(400, "bad decision");
      const answers = b.answers && typeof b.answers === "object" ? (b.answers as Record<string, string[]>) : undefined;
      const a = app.engine.decideApproval(params.id, b.decision, device.name, answers);
      if (!a) throw new HttpError(404, "approval not found");
      return a;
    }),
    // A device shows a question the agent can go on without: its time to answer starts now.
    route("POST", "/api/approvals/:id/seen", async ({ params }) => {
      const a = app.engine.seenApproval(params.id);
      if (!a) throw new HttpError(404, "approval not found");
      return a;
    }),
    // You started answering a question the agent could go on without: it waits for your answer now.
    route("POST", "/api/approvals/:id/hold", async ({ params }) => {
      const a = app.engine.holdApproval(params.id);
      if (!a) throw new HttpError(404, "approval not found");
      return a;
    }),

    // devices & pairing
    route("GET", "/api/devices", ({ device }) => app.store.listDevices().map((d) => ({ ...d, current: d.id === device.id }))),
    route("PATCH", "/api/devices/:id", async ({ params, body }) => {
      const b = await body();
      app.store.renameDevice(params.id, String(b.name ?? "").slice(0, 60) || "Device");
      return { ok: true };
    }),
    peerRoute("DELETE", "/api/devices/:id", ({ params, device }) => {
      if (device.scope === "peer" && params.id !== device.id) throw new HttpError(403, "This sign-in can only sign itself out.", "peer_scope");
      app.auth.revoke(params.id);
      return { ok: true };
    }),
    route("POST", "/api/pairing-codes", async () => {
      const c = await app.auth.createPairingCode();
      return { ...c, url: app.config.publicUrl };
    }),
    // ---- Other machines' hubs (Settings → Machines) ----
    route("GET", "/api/machines", () => app.machines.list()),
    route("POST", "/api/machines/link", async ({ body }) => {
      const b = (await body()) as { url?: string; code?: string };
      return app.machines.link(String(b.url ?? ""), String(b.code ?? ""));
    }),
    route("POST", "/api/machines/invite", ({ url }) => app.machines.invite((app.config.publicUrl || url.origin).replace(/\/+$/, ""))),
    route("GET", "/api/machines/invites/:token", ({ params }) => app.machines.inviteStatus(params.token)),
    route("POST", "/api/machines/:id/pair-code", ({ params }) => app.machines.pairCode(params.id)),
    route("POST", "/api/machines/:id/connect", ({ params }) => app.machines.connect(params.id)),
    // Unlink: a person (the machine and every machine it was introduced to drop it), or, with ?peer=1, the linked
    // machine itself telling this one it unlinked it.
    peerRoute("DELETE", "/api/machines/:id", async ({ params, url, device }) => {
      if (url.searchParams.get("peer") === "1") app.machines.peerRemove(device, params.id);
      else if (device.scope === "peer") throw new HttpError(403, "This sign-in belongs to another machine's agents and can't use this.", "peer_scope");
      else if (device.hubId) await app.machines.removeIntroduced(device, params.id);
      else await app.machines.remove(params.id);
      return { ok: true };
    }),
    // Linked machines' hubs, making links two-way and introducing machines (see machines.ts).
    peerRoute("GET", "/api/machines/peer", ({ device }) => app.machines.peerInfo(device, app.hubSettings().agentsAcrossChats)),
    peerRoute("POST", "/api/machines/peer", async ({ body, device }) => app.machines.peer(device, await body())),
    route("POST", "/api/machines/peer-code", async ({ body, device }) => app.machines.peerCodeFor(device, ((await body()) as { forHub?: unknown }).forHub)),
    // Other machines' agents reaching chats here (xchat.ts): only linked machines' hubs, and only while it's on here.
    peerRoute("GET", "/api/machines/chats", ({ device, url }) => app.xchat.listChats(xcaller(app, device), { query: url.searchParams.get("query") ?? "", limit: Number(url.searchParams.get("limit")) || 20 })),
    peerRoute("POST", "/api/machines/chats", async ({ device, body }) => app.xchat.start(xcaller(app, device), await body())),
    peerRoute("GET", "/api/machines/chats/:id", ({ device, params }) => app.xchat.chat(xcaller(app, device), params.id)),
    peerRoute("GET", "/api/machines/chats/:id/messages", ({ device, params, url }) =>
      app.xchat.read(xcaller(app, device), params.id, {
        limit: Number(url.searchParams.get("limit")) || undefined,
        before: Number(url.searchParams.get("before")) || undefined,
        seq: Number(url.searchParams.get("seq")) || undefined,
      }),
    ),
    peerRoute("POST", "/api/machines/chats/:id/messages", async ({ device, params, body }) => app.xchat.post(xcaller(app, device), params.id, await body())),
    peerRoute("GET", "/api/machines/chats/:id/reply", ({ device, params, url }) => app.xchat.reply(xcaller(app, device), params.id, url.searchParams.get("after") ?? "")),
    // The hub that linked this one asks for its notifications.
    route("PUT", "/api/push/forward", async ({ body }) => {
      app.machines.setForward(await body());
      return { ok: true };
    }),
    route("DELETE", "/api/push/forward", async ({ body }) => {
      app.machines.removeForward(await body());
      return { ok: true };
    }),

    // ---- Model pool: this hub as one of the pool's machines (pool/node.ts), for the hub that runs the pool. Full-scope
    // sign-ins only (route, not peerRoute): a linked machine's agents can't start processes or downloads here. ----
    route("GET", "/api/pool/node", ({ url }) => app.poolNode.infoFor(url.searchParams)),
    route("GET", "/api/pool/node/helpers", ({ url }) => app.poolNode.helperGpus(url.searchParams)),
    route("POST", "/api/pool/node/install", async ({ body }) => app.poolNode.handle("install", await body().catch(() => null))),
    route("POST", "/api/pool/node/helper", async ({ body }) => app.poolNode.handle("helper", await body().catch(() => null))),
    route("POST", "/api/pool/node/model", async ({ body }) => app.poolNode.handle("model", await body().catch(() => null))),
    route("POST", "/api/pool/node/server", async ({ body }) => app.poolNode.handle("server", await body().catch(() => null))),
    // ---- Model pool: the pool set up on this hub (pool/pool.ts), as docs/MODEL-POOL.md describes. People's devices
    // and full-scope hub sign-ins only (route, not peerRoute). ----
    route("GET", "/api/pool", () => app.pool.view()),
    route("PUT", "/api/pool", async ({ body }) => app.pool.update(((await body().catch(() => null)) as { config?: unknown } | null)?.config)),
    route("POST", "/api/pool/check", () => app.pool.check()),
    route("POST", "/api/pool/start", () => app.pool.start()),
    route("POST", "/api/pool/stop", () => app.pool.stop()),
    route("GET", "/api/pool/models", ({ url }) => app.pool.models(url.searchParams.get("repo") ?? "")),
    route("PUT", "/api/pool/hf-token", async ({ body }) => app.pool.setHfToken(await body().catch(() => null))),
    route("GET", "/api/pool/helper-command", ({ url }) => app.pool.helperCommand(url.searchParams, app.config.publicUrl || url.origin)),
    route("GET", "/api/pool/tailscale", () => app.pool.tailscale()),
    route("POST", "/api/pool/model/remove", async ({ body }) => app.pool.removeModel(((await body().catch(() => null)) as { files?: unknown } | null)?.files)),
    // ---- This Mac as a server (mac.ts): what keeps it from running unattended; its dialogs; System Settings opened.
    route("GET", "/api/mac", () => {
      if (process.platform !== "darwin") throw new HttpError(404, "This hub isn't on a Mac.", "not_mac");
      return app.mac.status();
    }),
    route("POST", "/api/mac/open", async ({ body }) => app.mac.open(((await body().catch(() => null)) as { pane?: unknown } | null)?.pane)),
    route("POST", "/api/mac/dialogs/:id/dismiss", ({ params }) => app.mac.dismiss(params.id)),
    route("POST", "/api/mac/dialogs/:id/stop", ({ params }) => app.mac.stopAsker(params.id)),
    // The notice that the Mac crashed or lost power, put away.
    route("POST", "/api/mac/crash/dismiss", () => app.mac.dismissCrash()),
    // A setting fixed by the person in a terminal, with sudo and their own Mac password typed by them (Crosstalk never
    // has it): automatic login (the Mac starts Crosstalk again by itself after an update or a power cut), or never
    // sleeping and starting up after a power cut. Fixed commands only.
    route("POST", "/api/mac/fix", async ({ body }) => {
      if (process.platform !== "darwin") throw new HttpError(404, "This hub isn't on a Mac.", "not_mac");
      const b = (await body().catch(() => ({}))) as { what?: unknown; cols?: number; rows?: number };
      const user = userInfo().username;
      if (!/^[a-z_][a-z0-9_.-]*$/i.test(user)) throw new HttpError(400, "This Mac's user name can't be used here.");
      const c = macFixCommand(b.what, user);
      if (!c) throw new HttpError(400, "Fix what? autologin or power.");
      return app.pty.spawn(c.argv, { title: c.title, purpose: "shell", cwd: homedir(), env: { PATH: "/usr/bin:/bin:/usr/sbin:/sbin", HOME: homedir(), LANG: process.env.LANG ?? "en_US.UTF-8", TERM: "xterm-256color" }, cols: b.cols, rows: b.rows });
    }),
    // ---- The memory guard (memory.ts): what's heavy on this machine, and how close it is to thrashing.
    route("GET", "/api/memory", () => app.memory.status()),

    // ---- The local AI image editor (imageEditor.ts): Settings switches it on and off.
    route("GET", "/api/image-editor", () => app.imageEditor.status()),
    route("POST", "/api/image-editor", async ({ body }) => {
      const b = (await body().catch(() => null)) as { on?: unknown; force?: unknown } | null;
      if (typeof b?.on !== "boolean") throw new HttpError(400, "Say whether to switch it on: { on: true } or { on: false }.");
      return app.imageEditor.set(b.on, b.force === true);
    }),

    // providers (guided setup)
    route("GET", "/api/providers", () => app.providers.list()),
    route("POST", "/api/providers/refresh", async () => {
      await app.providers.refreshAll();
      void app.providers.refreshUsage();
      return app.providers.list();
    }),
    route("POST", "/api/providers/:p/refresh", async ({ params }) => {
      const st = await app.providers.refresh(P(params.p));
      void app.providers.refreshUsage(P(params.p));
      return st;
    }),
    route("GET", "/api/providers/:p/models", ({ params, url }) => app.providers.models(P(params.p), url.searchParams.get("account") || undefined)),
    route("POST", "/api/providers/:p/install", ({ params }) => app.providers.install(P(params.p))),
    route("POST", "/api/providers/:p/login", async ({ params, body }) => {
      const b = await body().catch(() => ({}));
      return app.providers.login(P(params.p), b.method);
    }),
    route("POST", "/api/providers/:p/logout", async ({ params }) => {
      await app.providers.logout(P(params.p));
      return { ok: true };
    }),
    route("POST", "/api/providers/:p/apikey", async ({ params, body }) => {
      const b = await body();
      const { writeSecret } = await import("./config");
      const key = { muse: "META_API_KEY", gemini: "GEMINI_API_KEY" }[params.p];
      if (!key) throw new HttpError(400, "API keys aren't used for this agent");
      writeSecret(key, b.apiKey ? String(b.apiKey).trim() : null);
      return app.providers.refresh(P(params.p));
    }),
    route("POST", "/api/usage/refresh", async () => {
      await app.providers.refreshUsage();
      return app.store.listUsage();
    }),
    route("GET", "/api/usage/history", ({ url }) => {
      const p = P(url.searchParams.get("provider") || "claude");
      const days = Math.min(Number(url.searchParams.get("days") || 7), 60);
      return app.store.usageHistory(p, Date.now() - days * 86_400_000, url.searchParams.get("account") ?? undefined);
    }),

    // ---- Agent accounts: several sign-ins of the same agent, side by side ----
    route("GET", "/api/accounts", () => app.providers.accounts()),
    route("POST", "/api/accounts", async ({ body }) => {
      const b = await body();
      return app.providers.addAccount(P(String(b.provider ?? "")), String(b.label ?? ""));
    }),
    route("PATCH", "/api/accounts/:p/:id", async ({ params, body }) => app.providers.renameAccount(P(params.p), params.id, String((await body()).label ?? ""))),
    route("DELETE", "/api/accounts/:p/:id", ({ params }) => {
      app.providers.removeAccount(P(params.p), params.id);
      return { ok: true };
    }),
    route("POST", "/api/accounts/:p/:id/login", async ({ params, body }) => {
      const b = await body().catch(() => ({}));
      return app.providers.loginAccount(P(params.p), params.id, b.method ? String(b.method) : undefined);
    }),
    route("POST", "/api/accounts/:p/:id/logout", async ({ params }) => {
      await app.providers.logoutAccount(P(params.p), params.id);
      return app.providers.account(P(params.p), params.id);
    }),
    route("POST", "/api/accounts/:p/:id/refresh", ({ params }) => app.providers.refreshAccount(P(params.p), params.id)),
    // An account billed through an API key (new, or a new key for an existing one).
    route("POST", "/api/accounts/apikey", async ({ body }) => {
      const b = await body();
      const saved = await app.providers.setApiKeyAccount(P(String(b.provider ?? "")), String(b.apiKey ?? ""), { id: b.id ? String(b.id) : undefined, label: b.label ? String(b.label) : undefined, ...("workspaceId" in b ? { workspaceId: b.workspaceId === null ? null : String(b.workspaceId) } : {}) });
      // Agents already running on this account restart with the new key or workspace.
      for (const r of app.store.listRooms()) for (const m of app.store.listMembers(r.id)) if (m.provider === saved.provider && memberAccount(m) === saved.id) void app.engine.memberChanged(m.id);
      return saved;
    }),

    // An account that runs the agent on a model server of your own (new, or changed).
    route("POST", "/api/accounts/endpoint", async ({ body }) => {
      const b = await body();
      const saved = app.providers.setEndpointAccount(P(String(b.provider ?? "")), {
        id: b.id ? String(b.id) : undefined,
        label: b.label ? String(b.label) : undefined,
        baseUrl: String(b.baseUrl ?? ""),
        ...("apiKey" in b ? { apiKey: b.apiKey === null ? null : String(b.apiKey) } : {}),
        models: b.models,
        contextWindow: b.contextWindow,
        protocol: b.protocol,
        chatPath: b.chatPath,
        contexts: b.contexts,
        extra: b.extra,
      });
      // Agents already running on it restart with the new settings.
      for (const r of app.store.listRooms()) for (const m of app.store.listMembers(r.id)) if (m.provider === saved.provider && memberAccount(m) === saved.id) void app.engine.memberChanged(m.id);
      return saved;
    }),
    // Checks a model server from the hub (where a local one is reachable): its models and context size.
    route("POST", "/api/accounts/endpoint/probe", async ({ body }) => {
      const b = await body();
      return app.providers.probeEndpoint(String(b.baseUrl ?? ""), b.apiKey ? String(b.apiKey) : "");
    }),

    // supporting tools
    route("GET", "/api/tools/github", async () => (await import("./tools")).githubStatus(app)),
    route("POST", "/api/tools/github/login", async () => (await import("./tools")).githubLogin(app)),
    route("POST", "/api/tools/github/logout", async () => {
      await (await import("./tools")).githubLogout(app);
      return { ok: true };
    }),

    // push notifications
    route("GET", "/api/push/key", ({ device }) => ({ publicKey: app.push.publicKey(), subscribed: app.push.hasSubscription(device.id) })),
    route("POST", "/api/push/subscribe", async ({ body, device }) => {
      const b = await body();
      app.push.subscribe(device.id, String(b.endpoint ?? ""));
      return { ok: true };
    }),
    route("POST", "/api/push/unsubscribe", async ({ body }) => {
      const b = await body();
      app.push.unsubscribe(String(b.endpoint ?? ""));
      return { ok: true };
    }),
    route("POST", "/api/push/test", async () => {
      await app.push.send({ title: "Crosstalk", body: "Notifications are working.", url: "./", tag: "test" });
      return { ok: true };
    }),

    // terminals
    route("GET", "/api/pty", () => app.pty.list()),
    route("GET", "/api/pty/:id", ({ params }) => {
      const info = app.pty.get(params.id);
      if (!info) throw new HttpError(404, "terminal not found");
      return { info, scrollback: app.pty.scrollback(params.id) };
    }),
    route("POST", "/api/pty", async ({ body }) => {
      const b = await body().catch(() => ({}));
      const shell = process.env.SHELL || "/bin/bash";
      return app.pty.spawn([shell, "-l"], {
        title: "Shell",
        purpose: "shell",
        cwd: b.cwd || app.config.workspaceRoot,
        env: app.providers.agentEnv(),
        cols: b.cols,
        rows: b.rows,
      });
    }),
    route("DELETE", "/api/pty/:id", ({ params }) => {
      app.pty.kill(params.id);
      return { ok: true };
    }),
  ];
  // 0.4 features each own their routes (docs/SPEC-0.4.md): ask others, spend and limits, AI services.
  return [...core, ...askRoutes(app), ...spendRoutes(app), ...serviceRoutes(app), ...searchRoutes(app), ...bookmarkRoutes(app), ...localModelRoutes(app), ...setupRoutes(app), ...templateRoutes(app), ...signInRoutes(app)];
}

/** A request's `memberId` (a group chat's agent), null when it names none. */
function memberIdOf(b: unknown): string | null {
  const id = (b as { memberId?: unknown } | null)?.memberId;
  return typeof id === "string" && id ? id : null;
}

/**
 * A message the app changes without asking twice (the agent hadn't read it) must still be unread: one the agent read
 * meanwhile (a turn started on another device) would be a rewind, which is asked about twice. 409 says to look again.
 */
function stillUnread(app: App, messageId: string) {
  const m = app.store.getMessage(messageId);
  if (!m) return;
  // In a group chat, any of its agents having read it makes it a rewind.
  const seq = app.store.messageSeq(m.id);
  const member = app.store.listMembers(m.roomId).find((x) => seq <= app.store.getLastSeen(x.id).seq);
  if (!member) return;
  const group = app.store.getRoom(m.roomId)?.chat?.group;
  const who = group ? `@${member.handle}` : PROVIDER_INFO[member.provider]?.name ?? "The agent";
  // An agent with no way back: there's nothing to tap for.
  if (!group && isNoRewindAgent(member.provider)) throw new HttpError(409, `${who} has just read this message, so it stays as it is. Send what you meant to change as a new message.`, "read");
  throw new HttpError(409, `${who} has just read this message. Tap it again to see what changing it takes back.`, "read");
}

export function startServer(app: App) {
  const routes = buildRoutes(app);
  const webDir = resolveWebDir();
  const sockets = new Set<ServerWebSocket<WsData>>();
  const disconnect = (ws: ServerWebSocket<WsData>) => {
    ws.data.off?.();
    ws.data.off = undefined;
    for (const s of ws.data.steps?.values() ?? []) if (s.timer) clearTimeout(s.timer);
    ws.data.steps?.clear();
    if (ws.data.visible) app.push.setVisible(ws.data.device.id, -1);
    ws.data.visible = false;
    sockets.delete(ws);
  };
  const allowed = (ws: ServerWebSocket<WsData>) => {
    const device = app.store.getDevice(ws.data.device.id);
    if (device && device.scope !== "peer") return true;
    disconnect(ws);
    ws.close(1008, "This device has been signed out.");
    return false;
  };
  const offRevoked = app.auth.onRevoked((deviceId) => {
    for (const ws of sockets) if (ws.data.device.id === deviceId) allowed(ws);
  });

  const server = Bun.serve<WsData>({
    port: app.config.port,
    hostname: app.config.host,
    idleTimeout: 120,
    maxRequestBodySize: Number.MAX_SAFE_INTEGER, // no upload size limit; uploads.ts guards free disk space instead
    async fetch(req, srv) {
      const url = new URL(req.url);
      const cors = corsHeaders(req);
      if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
      try {
        // The agents' internal API is served on the hub's Unix socket only (internal-server.ts), never here. The one
        // exception is the setup API, which answers here too — for a request made on this machine straight to the hub
        // (loopback peer address, loopback Host, no proxy headers) and only with the setup key. That is the way left
        // open to a program whose sandbox blocks Unix sockets but allows localhost (setup/cli.ts askHub), and it grants
        // nothing more: the key comes from run/internal-secret, which only this user can read. Anything arriving
        // through `tailscale serve` or another proxy finds nothing here, key or not, and no CORS headers go with it, so
        // no web page can read the answer.
        if (url.pathname.startsWith("/internal/")) {
          if (url.pathname.startsWith("/internal/setup/") && req.method === "POST" && directLocal(req, srv.requestIP(req)?.address ?? null)) return handleSetupInternal(app, req, url);
          return new Response("not found", { status: 404 });
        }

        if (url.pathname === "/api/push/latest") {
          // The service worker asks for the text of a payload-less push; the endpoint itself is the capability.
          return json(app.push.takeLatest(url.searchParams.get("endpoint") ?? "") ?? { title: "Crosstalk", body: "Something needs your attention.", url: "./", tag: "crosstalk" }, 200, cors);
        }
        if (url.pathname === "/api/push/notes" && req.method === "POST") {
          // Newer service workers take every notification waiting for them, each with its own text and tag.
          const b = (await req.json().catch(() => ({}))) as { endpoint?: unknown };
          return json(app.push.take(typeof b.endpoint === "string" ? b.endpoint : ""), 200, cors);
        }

        if (url.pathname === "/api/health") return json({ ok: true, version: app.hubInfo().version, name: "crosstalk" }, 200, cors);
        // The setup guide for agents on this machine (setup/index.ts): never through tailscale serve or another proxy.
        if (url.pathname === "/setup.md") return setupGuideResponse(req, srv.requestIP(req)?.address ?? null);

        // The connect command runs on a computer that isn't paired; its one-time code is the permission.
        const claim = url.pathname.match(/^\/api\/computers\/claim\/([A-Za-z0-9]{8,64})(\/script|\/ps1)?$/);
        if (claim) {
          if (tooManyFailures("claim")) return new Response(`${TOO_MANY}\n`, { status: 429, headers: { "content-type": "text/plain; charset=utf-8" } });
          try {
            if (claim[2] && req.method === "GET") {
              const hub = (app.config.publicUrl || url.origin).replace(/\/+$/, "");
              const body = claim[2] === "/ps1" ? app.computers.windowsScript(claim[1], hub) : app.computers.script(claim[1], hub);
              return new Response(body, { headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" } });
            }
            if (!claim[2] && req.method === "POST") {
              const computer = await app.computers.claim(claim[1], (await req.json().catch(() => ({}))) as Record<string, unknown>);
              log.info(`connected computer "${computer.label}" as ${computer.name}`);
              return json(computer, 200, cors);
            }
          } catch (e) {
            const status = e instanceof HttpError ? e.status : 500;
            if (status === 401) recordFailure("claim");
            return new Response(`${e instanceof Error ? e.message : String(e)}\n`, { status, headers: { "content-type": "text/plain; charset=utf-8" } });
          }
        }

        // The Linux setup command runs on a machine that isn't paired; its one-time token is the permission.
        const install = url.pathname.match(/^\/api\/machines\/install\/([A-Za-z0-9]{16,64})(?:\/(crosstalk-hub-linux-(x64|arm64)|install\.sh|claim))?$/);
        if (install) {
          if (tooManyFailures("install")) return new Response(`${TOO_MANY}\n`, { status: 429, headers: { "content-type": "text/plain; charset=utf-8" } });
          try {
            const [, token, part, arch] = install;
            const text = (body: string) => new Response(body, { headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" } });
            if (!part && req.method === "GET") return text(app.machines.script(token, (app.config.publicUrl || url.origin).replace(/\/+$/, "")));
            if (part === "install.sh" && req.method === "GET") return text(app.machines.installer(token));
            if (arch && req.method === "GET") return new Response(Bun.file(app.machines.binary(token, arch)), { headers: { "content-type": "application/octet-stream", "cache-control": "no-store" } });
            if (part === "claim" && req.method === "POST") return json(await app.machines.claim(token, await req.json().catch(() => ({}))), 200, cors);
            return new Response("not found\n", { status: 404 });
          } catch (e) {
            const status = e instanceof HttpError ? e.status : 500;
            if (status === 401) recordFailure("install");
            return new Response(`${e instanceof Error ? e.message : String(e)}\n`, { status, headers: { "content-type": "text/plain; charset=utf-8" } });
          }
        }

        // A computer's short helper command fetches its long one here: it isn't paired, so its token is the permission
        // (and what it gets is no secret: the build, its address and port). Wrong tokens count like wrong codes.
        const helper = url.pathname.match(/^\/api\/pool\/helper\/([a-z0-9]{16,64})$/);
        if (helper && req.method === "GET") {
          const text = (body: string, status = 200) => new Response(body, { status, headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" } });
          if (tooManyFailures("pool-helper")) return text(`${TOO_MANY}\n`, 429);
          try {
            return text(app.pool.helperScript(helper[1]));
          } catch (e) {
            const status = e instanceof HttpError ? e.status : 500;
            if (status !== 404) return text(`${e instanceof Error ? e.message : String(e)}\n`, status);
            recordFailure("pool-helper");
            // The computer's window runs what it's sent (PowerShell and sh alike): what to do, as words to show.
            return text(`echo "${(e as Error).message.replace(/[^\w .,:()'-]/g, "")}"\n`);
          }
        }

        // A linked machine's hub passes on a notification; its own key (not a device sign-in) is the permission.
        if (url.pathname === "/api/push/relay" && req.method === "POST") {
          if (tooManyFailures("relay")) return json({ error: TOO_MANY }, 429, cors);
          try {
            await app.machines.relay(tokenFromRequest(req, url), await req.json().catch(() => ({})));
            return json({ ok: true }, 200, cors);
          } catch (e) {
            const status = e instanceof HttpError ? e.status : 500;
            if (status === 401) recordFailure("relay");
            return json({ error: e instanceof Error ? e.message : String(e) }, status, cors);
          }
        }

        if (url.pathname === "/api/pair" && req.method === "POST") {
          if (tooManyFailures("pair")) return json({ error: TOO_MANY }, 429, cors);
          const b = (await req.json().catch(() => ({}))) as { code?: string; name?: string; platform?: string };
          const res = await app.auth.pair(String(b.code ?? ""), String(b.name ?? "Device"), String(b.platform ?? ""));
          if (!res) recordFailure("pair");
          if (!res) return json({ error: "That code is wrong or expired. Make a new one on a paired device, or run `crosstalk-hub pair` on the server." }, 401, cors);
          log.info(`paired device "${res.device.name}" (${res.device.platform})`);
          return json({ ...res, hub: app.hubInfo() }, 200, cors);
        }

        if (url.pathname === "/api/ws") {
          const device = await app.auth.verify(tokenFromRequest(req, url));
          if (!device) return new Response("unauthorized", { status: 401 });
          // Live events carry everything (terminals included): people's devices only.
          if (device.scope === "peer") return new Response("forbidden", { status: 403 });
          if (srv.upgrade(req, { data: { device, v: protocolOf(url) } })) return undefined;
          return new Response("upgrade failed", { status: 400 });
        }

        if (url.pathname.startsWith("/api/")) {
          const device = await app.auth.verify(tokenFromRequest(req, url));
          if (!device) return json({ error: "unauthorized" }, 401, cors);
          for (const r of routes) {
            if (r.method !== req.method) continue;
            const m = r.pattern.exec(url.pathname);
            if (!m) continue;
            if (device.scope === "peer" && !r.peer) return json({ error: "This sign-in belongs to another machine's agents and can't use this.", code: "peer_scope" }, 403, cors);
            const params: Record<string, string> = {};
            r.keys.forEach((k, i) => (params[k] = decodeURIComponent(m[i + 1])));
            const out = await r.handler({
              req,
              url,
              params,
              device,
              body: async () => {
                const t = await req.text();
                return t ? JSON.parse(t) : {};
              },
            });
            if (out instanceof Response) {
              for (const [key, value] of Object.entries(cors)) out.headers.set(key, value);
              return out;
            }
            return json(out ?? { ok: true }, 200, cors);
          }
          return json({ error: "not found" }, 404, cors);
        }

        return serveStatic(webDir, url.pathname);
      } catch (e) {
        if (e instanceof HttpError) return json({ error: e.message, ...(e.code ? { code: e.code } : {}) }, e.status, cors);
        const msg = e instanceof Error ? e.message : String(e);
        log.error(`${req.method} ${url.pathname}: ${msg}`);
        return json({ error: msg }, 500, cors);
      }
    },
    websocket: {
      idleTimeout: 120,
      sendPings: true,
      open(ws) {
        if (!allowed(ws)) return;
        sockets.add(ws);
        const send = (e: ServerEvent) => { if (allowed(ws)) ws.send(JSON.stringify(e)); };
        send({ t: "hello", device: ws.data.device, hub: app.hubInfo() });
        // A sign-in started from the phone (its link and code), and what the person bookmarks, go to people's own devices only, never another hub's.
        const person = isPersonDevice(ws.data.device);
        ws.data.off = app.bus.on((e) => {
          if ((e.t === "signin.session" || e.t === "bookmark") && !person) return;
          if (ws.data.v >= 2) send(e.t === "activity" ? { t: "activity", activity: previewActivity(e.activity) } : e);
          else if (e.t === "activity.delta") legacyStep(ws, e, send);
          else send(e);
        });
      },
      message(ws, raw) {
        if (!allowed(ws)) return;
        let e: ClientEvent;
        try {
          e = JSON.parse(String(raw));
        } catch {
          return;
        }
        if (e.t === "pty.input") app.pty.write(e.ptyId, e.data);
        else if (e.t === "pty.resize") app.pty.resize(e.ptyId, e.cols, e.rows);
        else if (e.t === "presence") {
          if (!!e.visible !== !!ws.data.visible) app.push.setVisible(ws.data.device.id, e.visible ? 1 : -1);
          ws.data.visible = !!e.visible;
        } else if (e.t === "ping") ws.send(JSON.stringify({ t: "pong" }));
      },
      close(ws) {
        disconnect(ws);
      },
    },
  });
  /**
   * An older app replaces a step with each "activity" event it gets: it gets the step whole, at most once a second while
   * its output streams (the newest output catches up after), and at once when its title, kind or status changes.
   */
  function legacyStep(ws: ServerWebSocket<WsData>, e: Extract<ServerEvent, { t: "activity.delta" }>, send: (e: ServerEvent) => void) {
    const steps = (ws.data.steps ??= new Map());
    const cur = steps.get(e.activityId) ?? { at: 0, timer: null };
    steps.set(e.activityId, cur);
    const sendWhole = () => {
      if (cur.timer) clearTimeout(cur.timer);
      cur.timer = null;
      cur.at = Date.now();
      const activity = app.engine.liveActivity(e.activityId) ?? app.store.getActivity(e.activityId);
      if (activity) send({ t: "activity", activity });
      // Finished: nothing more streams for it.
      if (!activity || activity.status !== "running") steps.delete(e.activityId);
    };
    const wait = cur.at + LEGACY_STEP_MS - Date.now();
    if (e.title !== undefined || e.kind !== undefined || e.status !== undefined || wait <= 0) sendWhole();
    else cur.timer ??= setTimeout(sendWhole, wait);
  }

  log.info(`listening on http://${app.config.host}:${server.port}`);
  // The agents' internal API runs beside it on a Unix socket, and stops with it.
  const internal = startInternalServer(app);
  const stop = server.stop.bind(server);
  server.stop = ((closeActiveConnections?: boolean) => {
    offRevoked();
    internal.stop();
    return stop(closeActiveConnections);
  }) as typeof server.stop;
  return server;
}

const ALLOWED_ORIGINS = [/^tauri:\/\/localhost$/, /^https?:\/\/tauri\.localhost$/, /^http:\/\/localhost(:\d+)?$/, /^http:\/\/127\.0\.0\.1(:\d+)?$/, /^https:\/\/[\w.-]+\.ts\.net$/];

/**
 * Throttles wrong guesses at the two endpoints that accept a code without a paired device (pairing and
 * connecting a computer): after 20 failures in 10 minutes, further attempts are refused until the window passes.
 */
const FAIL_WINDOW = 10 * 60_000;
const FAIL_LIMIT = 20;
const failures = new Map<string, number[]>();
function tooManyFailures(bucket: string): boolean {
  const now = Date.now();
  const recent = (failures.get(bucket) ?? []).filter((t) => now - t < FAIL_WINDOW);
  failures.set(bucket, recent);
  return recent.length >= FAIL_LIMIT;
}
function recordFailure(bucket: string) {
  failures.set(bucket, [...(failures.get(bucket) ?? []), Date.now()]);
}
/** For tests. */
export function resetFailureLimits() {
  failures.clear();
}
const TOO_MANY = "Too many wrong codes. Wait a few minutes, then try again.";

function corsHeaders(req: Request): Record<string, string> {
  const origin = req.headers.get("origin");
  // Auth is a bearer token (never a cookie), so reflecting known app origins is safe.
  if (!origin || !ALLOWED_ORIGINS.some((r) => r.test(origin))) return {};
  return {
    "access-control-allow-origin": origin,
    "access-control-allow-headers": "authorization, content-type",
    "access-control-allow-methods": "GET, POST, PUT, PATCH, DELETE, OPTIONS",
    "access-control-max-age": "600",
    vary: "origin",
  };
}

function resolveWebDir(): string | null {
  const candidates = [process.env.CROSSTALK_WEB_DIR, join(dirname(Bun.main), "../../web/dist"), join(process.cwd(), "web/dist"), join(process.cwd(), "../web/dist")];
  for (const c of candidates) if (c && existsSync(join(c, "index.html"))) return resolve(c);
  return null;
}

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json",
  ".webmanifest": "application/manifest+json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
  ".txt": "text/plain; charset=utf-8",
};

const SECURITY_HEADERS = {
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
  "x-frame-options": "DENY",
};

async function serveStatic(webDir: string | null, pathname: string): Promise<Response> {
  const clean = normalize(decodeURIComponent(pathname)).replace(/^(\.\.[/\\])+/, "");
  const rel = clean === "/" ? "/index.html" : clean;
  const type = (p: string) => MIME[extname(p)] ?? "application/octet-stream";
  const cache = (p: string) => (p.includes("/assets/") ? "public, max-age=31536000, immutable" : "no-cache");

  const emb = embeddedAsset(rel);
  if (emb) return new Response(emb, { headers: { "content-type": type(rel), "cache-control": cache(rel), ...SECURITY_HEADERS } });
  if (webDir) {
    const full = join(webDir, rel);
    if (full.startsWith(webDir) && existsSync(full) && statSync(full).isFile()) {
      return new Response(Bun.file(full), { headers: { "content-type": type(full), "cache-control": cache(rel), ...SECURITY_HEADERS } });
    }
  }
  // SPA fallback
  const index = embeddedAsset("/index.html") ?? (webDir && existsSync(join(webDir, "index.html")) ? Bun.file(join(webDir, "index.html")) : null);
  if (index && !extname(rel)) return new Response(index, { headers: { "content-type": MIME[".html"], "cache-control": "no-cache", ...SECURITY_HEADERS } });
  if (!index) return new Response("Crosstalk hub is running. The web app hasn't been built (run `bun run build:web`).", { status: 200, headers: { "content-type": "text/plain" } });
  return new Response("not found", { status: 404 });
}
