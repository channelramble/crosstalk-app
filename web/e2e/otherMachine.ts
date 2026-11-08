import type { Page, Route, WebSocketRoute } from "@playwright/test";
import type { Approval, Member, PromptTemplate, Room } from "@crosstalk/shared";

/** Answers the app's pings, as a hub does. */
export const pong = (ws: WebSocketRoute) => ws.onMessage((data) => { if (JSON.parse(String(data)).t === "ping") ws.send(JSON.stringify({ t: "pong" })); });

/**
 * A second machine this device is paired with, "Linux box", whose hub the test plays: its state (held until `release`
 * when `held`), its chats' histories, answers to its requests, and its live updates (which it can stop answering).
 * The hub the app was opened from stays the first machine, and the one showing. With `pins`, it keeps its chats' pins
 * as a hub does (POST /api/rooms/:id/pin); without, it's a hub from before pins, which doesn't have the route. With
 * `templates`, its state has those (Settings → Templates); without, it's a hub from before templates.
 */
export async function otherMachine(page: Page, token: string, opts: { port: number; held?: boolean; rooms?: Room[]; members?: Member[]; approvals?: Approval[]; pins?: boolean; templates?: PromptTemplate[] }) {
  const base = `http://127.0.0.1:${opts.port}`;
  await page.addInitScript(({ token, base }) => {
    localStorage.setItem("crosstalk.machines.v1", JSON.stringify({ list: [{ baseUrl: "", token, deviceName: "Browser tests" }, { baseUrl: base, token: "linux-box-token", deviceName: "Browser tests" }], active: "" }));
  }, { token, base });
  const cors = { "access-control-allow-origin": "http://127.0.0.1:5198", "access-control-allow-headers": "authorization, content-type", "access-control-allow-methods": "GET, POST, PUT, PATCH, DELETE, OPTIONS" };
  const at = Date.now();
  const rooms = opts.rooms ?? [];
  const members = opts.members ?? [];
  const approvals = opts.approvals ?? [];
  const answered: { id: string; body: unknown }[] = [];
  /** Every pin request it got (an older hub's too, which it answers "not found"). */
  const pinned: { id: string; body: { pinned: boolean; order?: number } }[] = [];
  let release = () => {};
  const gate = opts.held ? new Promise<void>((resolve) => (release = resolve)) : Promise.resolve();
  const hub = { version: "test", hostname: "linux-box", platform: "linux", workspaceRoot: "/home/me/Crosstalk", publicUrl: null, id: "h_linux", name: "Linux box" };
  const json = (route: Route, body: unknown, status = 200) => route.fulfill({ status, headers: cors, contentType: "application/json", body: JSON.stringify(body) });
  const sockets: WebSocketRoute[] = [];
  let refusing = false;
  const send = (e: unknown) => sockets.at(-1)?.send(JSON.stringify(e));
  await page.route(`${base}/**`, async (route) => {
    const req = route.request();
    const path = new URL(req.url()).pathname;
    if (req.method() === "OPTIONS") return route.fulfill({ status: 204, headers: cors });
    if (path === "/api/state") {
      await gate;
      return json(route, {
        hub,
        rooms,
        members,
        approvals: approvals.filter((a) => a.status === "pending"),
        usage: [],
        roomActivity: {},
        device: { id: "d1", name: "Browser tests", platform: "Web", createdAt: at, lastSeenAt: at },
        providers: [{ provider: "codex", installed: true, version: "test", binPath: null, signedIn: true, account: "me@linux", plan: null, authMethod: null, error: null, checkedAt: at }],
        accounts: [{ provider: "codex", id: "default", label: "Main", kind: "signin", signedIn: true, account: "me@linux", plan: null, authMethod: null, error: null, checkedAt: at }],
        ...(opts.templates ? { templates: opts.templates } : {}),
      });
    }
    const history = /^\/api\/rooms\/([^/]+)\/history$/.exec(path);
    if (history) {
      const room = rooms.find((r) => r.id === history[1]);
      return room ? json(route, { room, messages: [], turns: [], activities: [], approvals: approvals.filter((a) => a.roomId === room.id), tasks: {}, totals: null, hasMore: false }) : json(route, { error: "room not found" }, 404);
    }
    const decide = /^\/api\/approvals\/([^/]+)$/.exec(path);
    if (decide && req.method() === "POST") {
      const a = approvals.find((x) => x.id === decide[1]);
      if (!a) return json(route, { error: "not found" }, 404);
      answered.push({ id: a.id, body: req.postDataJSON() });
      Object.assign(a, { status: "approved", decision: "approve", decidedBy: "Browser tests", decidedAt: Date.now() });
      send({ t: "approval", approval: a });
      return json(route, a);
    }
    if (path.startsWith("/api/providers/")) return json(route, { provider: "codex", live: true, error: null, models: [] });
    const pin = /^\/api\/rooms\/([^/]+)\/pin$/.exec(path);
    if (pin && req.method() === "POST") {
      const body = req.postDataJSON() as { pinned: boolean; order?: number };
      pinned.push({ id: pin[1], body });
      const room = rooms.find((r) => r.id === pin[1]);
      if (opts.pins && !room) return json(route, { error: "That chat is gone. It may have been deleted on another device.", code: "no_room" }, 404);
      if (opts.pins && room) {
        // As pins.ts does: a move keeps when it was pinned; an unpin takes both away.
        if (body.pinned) Object.assign(room, { pinnedAt: room.pinnedAt ?? Date.now(), pinOrder: typeof body.order === "number" ? body.order : (room.pinOrder ?? 0) });
        else {
          delete room.pinnedAt;
          delete room.pinOrder;
        }
        send({ t: "room", room });
        return json(route, room);
      }
    }
    return json(route, { error: "not found" }, 404);
  });
  await page.routeWebSocket(`${base.replace("http", "ws")}/api/ws?**`, (ws) => {
    sockets.push(ws);
    if (refusing) return ws.close({ code: 1011 });
    pong(ws);
  });
  return {
    base,
    key: base,
    hub,
    answered,
    pinned,
    release: () => release(),
    send,
    /** Stops answering: its connection drops, and new ones are refused, until `refuse(false)`. */
    refuse(on: boolean) {
      refusing = on;
      if (on) sockets.at(-1)?.close({ code: 1011 });
    },
    sockets: () => sockets.length,
  };
}
