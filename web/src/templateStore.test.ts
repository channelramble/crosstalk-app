// Templates in the app's state (hubStore.ts, templateApi.ts): they come with the hub's state, `templates` events keep them in
// step, a change's answer shows at once unless newer word came first, a failed change says why, and a hub from before
// templates has none (not an empty list).
import { afterEach, expect, test } from "bun:test";
import type { PromptTemplate } from "@crosstalk/shared";

const originals = new Map<string, PropertyDescriptor | undefined>();
function replace(key: string, value: unknown) {
  if (!originals.has(key)) originals.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
  Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
}
afterEach(() => {
  for (const [key, desc] of originals) {
    if (desc) Object.defineProperty(globalThis, key, desc);
    else Reflect.deleteProperty(globalThis, key);
  }
  originals.clear();
});

class Socket {
  static OPEN = 1;
  static instances: Socket[] = [];
  readyState = 0;
  onopen?: () => void;
  onclose?: () => void;
  onerror?: () => void;
  onmessage?: (e: { data: string }) => void;
  constructor(public url: string) {
    Socket.instances.push(this);
  }
  send() {}
  close() {
    this.readyState = 3;
    this.onclose?.();
  }
  open() {
    this.readyState = 1;
    this.onopen?.();
  }
  message(value: unknown) {
    this.onmessage?.({ data: JSON.stringify(value) });
  }
}

const AT = 1_800_000_000_000;
const template = (id: string, name: string, over: Partial<PromptTemplate> = {}): PromptTemplate => ({ id, name, agent: null, account: null, model: null, effort: null, folder: null, text: `${name} {thing}`, createdAt: AT, updatedAt: AT, ...over });
const names = (list: PromptTemplate[] | null | undefined) => list?.map((t) => t.name) ?? null;

/**
 * The app with one machine, a fake hub at `base`, through the app's own store (as Settings and New chat use it). Its state
 * has `hub.templates` (none: a hub from before templates); a change to them is answered, when `arrive` is called, with the
 * list as the hub had it right after the change, or with `fail` if that's set.
 */
async function appWithHub(base: string, hub: { templates?: PromptTemplate[]; fail?: { status: number; error: string; code?: string } }) {
  Socket.instances = [];
  replace("WebSocket", Socket);
  replace("document", Object.assign(new EventTarget(), { visibilityState: "visible" }));
  replace("window", new EventTarget());
  replace("location", { origin: "http://localhost", href: "http://localhost/", hash: "" });
  replace("navigator", { userAgent: "test" });
  const seen = { states: 0, answer: null as ((list: PromptTemplate[]) => void) | null, sent: [] as { method: string; path: string; body: unknown }[] };
  replace("fetch", async (url: string, init?: RequestInit) => {
    const u = new URL(String(url));
    if (u.pathname === "/api/state") {
      seen.states++;
      return new Response(JSON.stringify({ hub: { id: "h", name: "Mac mini" }, device: { id: "d", name: "Phone" }, rooms: [], members: [], approvals: [], usage: [], providers: [], accounts: [], storage: null, roomActivity: {}, ...(hub.templates ? { templates: hub.templates } : {}) }));
    }
    if (u.pathname.startsWith("/api/templates")) {
      seen.sent.push({ method: init?.method ?? "GET", path: u.pathname, body: init?.body ? JSON.parse(String(init.body)) : undefined });
      return new Promise<Response>((res) => {
        seen.answer = (list) => res(hub.fail ? new Response(JSON.stringify({ error: hub.fail.error, ...(hub.fail.code ? { code: hub.fail.code } : {}) }), { status: hub.fail.status }) : new Response(JSON.stringify(list)));
      });
    }
    return new Response("{}");
  });
  // Loaded only now: the app's store listens on the page from the start.
  const { hubStore, useMachines, useStore } = await import("./store");
  const templates = await import("./templateApi");
  await useStore.getState().addMachine({ baseUrl: base, token: "t", deviceName: "Phone" });
  const store = hubStore(base)!;
  const socket = Socket.instances[0];
  socket.open();
  // Caught up after connecting (its state once more).
  for (let i = 0; i < 100 && (seen.states < 2 || store.getState().syncing); i++) await Bun.sleep(5);
  expect(seen.states).toBe(2);
  const machine = { key: base, name: "Mac mini", conn: store.getState().conn };
  return {
    store,
    seen,
    templates,
    list: () => store.getState().templates,
    summary: () => useMachines.getState().list.find((m) => m.key === base)?.templates,
    /** A change made on another device: the hub has it, and says so. */
    elsewhere(list: PromptTemplate[]) {
      hub.templates = list;
      socket.message({ t: "templates", templates: list });
    },
    /** A change from this device: taken by the hub at once (the list is `after` then), answered when `arrive` is called. */
    async change(work: (m: typeof machine) => Promise<PromptTemplate[]>, after: PromptTemplate[]) {
      seen.answer = null;
      const done = work(machine);
      for (let i = 0; i < 100 && !seen.answer; i++) await Bun.sleep(5);
      const answer = seen.answer;
      expect(answer).not.toBeNull();
      if (!hub.fail) hub.templates = after;
      return { arrive: async () => (answer!(after), await done), heard: () => socket.message({ t: "templates", templates: after }), done };
    },
    stop: () => useStore.getState().removeMachine(base),
  };
}

test("templates come with the hub's state and stay in step with its events, on the machine and in the sidebar's view of it", async () => {
  const app = await appWithHub("http://tpl-hub", { templates: [template("a", "Fix a bug"), template("b", "Plan it first")] });
  try {
    expect(names(app.list())).toEqual(["Fix a bug", "Plan it first"]);
    // New chat lists every machine's: the machine's summary has them too.
    expect(names(app.summary())).toEqual(["Fix a bug", "Plan it first"]);
    app.elsewhere([template("b", "Plan it first"), template("a", "Fix it")]);
    expect(names(app.list())).toEqual(["Plan it first", "Fix it"]);
    expect(names(app.summary())).toEqual(["Plan it first", "Fix it"]);
    app.elsewhere([]);
    expect(app.list()).toEqual([]);
  } finally {
    app.stop();
  }
});

test("a change's answer shows at once, and never undoes word of a newer change that came first", async () => {
  const one = template("a", "Fix a bug");
  const app = await appWithHub("http://tpl-hub-2", { templates: [one] });
  try {
    // Added here: shown from the answer, before its event; the request said what to add.
    const two = template("n", "Release notes", { agent: "codex", model: "gpt-5.5" });
    let change = await app.change((m) => app.templates.addTemplate(m, { name: "Release notes", text: "Release notes {thing}", agent: "codex", model: "gpt-5.5" }), [two, one]);
    expect(app.seen.sent.at(-1)).toEqual({ method: "POST", path: "/api/templates", body: { name: "Release notes", text: "Release notes {thing}", agent: "codex", model: "gpt-5.5" } });
    expect(names(app.list())).toEqual(["Fix a bug"]);
    expect(names(await change.arrive())).toEqual(["Release notes", "Fix a bug"]);
    expect(names(app.list())).toEqual(["Release notes", "Fix a bug"]);
    change.heard();
    expect(names(app.list())).toEqual(["Release notes", "Fix a bug"]);

    // Moved here, then renamed on another device before this one's answer: the rename stays.
    change = await app.change((m) => app.templates.moveTemplate(m, "a", 0), [one, two]);
    expect(app.seen.sent.at(-1)).toEqual({ method: "POST", path: "/api/templates/a/move", body: { to: 0 } });
    change.heard();
    app.elsewhere([template("a", "Fix it"), two]);
    await change.arrive();
    expect(names(app.list())).toEqual(["Fix it", "Release notes"]);

    // Renamed and deleted: each its own request, by id.
    change = await app.change((m) => app.templates.saveTemplate(m, "n", { name: "Notes" }), [template("a", "Fix it"), { ...two, name: "Notes" }]);
    expect(app.seen.sent.at(-1)).toEqual({ method: "PATCH", path: "/api/templates/n", body: { name: "Notes" } });
    await change.arrive();
    expect(names(app.list())).toEqual(["Fix it", "Notes"]);
    change = await app.change(async (m) => (await app.templates.deleteTemplate(m, "n"), []), [template("a", "Fix it")]);
    expect(app.seen.sent.at(-1)).toMatchObject({ method: "DELETE", path: "/api/templates/n" });
    await change.arrive();
    expect(names(app.list())).toEqual(["Fix it"]);
    change = await app.change((m) => app.templates.restoreStarters(m), [template("a", "Fix it"), template("s", "Review my changes", { starter: "review" })]);
    expect(app.seen.sent.at(-1)).toMatchObject({ method: "POST", path: "/api/templates/starters" });
    await change.arrive();
    expect(names(app.list())).toEqual(["Fix it", "Review my changes"]);
  } finally {
    app.stop();
  }
});

test("a hub from before templates has none (not an empty list), and a change there says to update it", async () => {
  const hub: { templates?: PromptTemplate[]; fail?: { status: number; error: string } } = {};
  const app = await appWithHub("http://tpl-old", hub);
  try {
    expect(app.list()).toBeNull();
    expect(app.store.getState().loadedAt).not.toBeNull();
    hub.fail = { status: 404, error: "not found" };
    const change = await app.change((m) => app.templates.addTemplate(m, { name: "x", text: "y" }), []);
    await change.arrive().catch(() => {});
    const e = await change.done.catch((err: unknown) => err);
    expect(e).toBeInstanceOf(app.templates.TemplateError);
    expect(e).toMatchObject({ message: "Update Crosstalk on Mac mini to keep templates there.", why: "older", machineKey: "http://tpl-old" });
    // Nothing is made up meanwhile.
    expect(app.list()).toBeNull();
  } finally {
    app.stop();
  }
});

test("the hub's refusal comes through in its own words, and deleting one that's already gone counts as deleted", async () => {
  const hub: { templates?: PromptTemplate[]; fail?: { status: number; error: string; code?: string } } = { templates: [template("a", "Fix a bug")] };
  const app = await appWithHub("http://tpl-refuse", hub);
  try {
    hub.fail = { status: 400, error: "Give the template a name." };
    let change = await app.change((m) => app.templates.saveTemplate(m, "a", { name: "" }), [template("a", "Fix a bug")]);
    await change.arrive().catch(() => {});
    expect(await change.done.catch((err: unknown) => err)).toMatchObject({ message: "Give the template a name.", why: "other" });
    expect(names(app.list())).toEqual(["Fix a bug"]);
    hub.fail = { status: 404, error: "That template is gone. It may have been deleted on another device.", code: "no_template" };
    change = await app.change(async (m) => (await app.templates.deleteTemplate(m, "b"), []), [template("a", "Fix a bug")]);
    await change.arrive();
    // Renaming one that's gone says so.
    change = await app.change((m) => app.templates.saveTemplate(m, "b", { name: "x" }), [template("a", "Fix a bug")]);
    await change.arrive().catch(() => {});
    expect(await change.done.catch((err: unknown) => err)).toMatchObject({ message: "That template is gone. It may have been deleted on another device.", why: "other", code: "no_template" });
  } finally {
    app.stop();
  }
});

test("a chat's first message is sent once it's made; one naming another agent, or one that can't go, waits in its message box", async () => {
  const saved = new Map<string, string>();
  replace("localStorage", { getItem: (k: string) => saved.get(k) ?? null, setItem: (k: string, v: string) => void saved.set(k, v), removeItem: (k: string) => void saved.delete(k) });
  replace("navigator", { userAgent: "test" });
  const posted: { url: string; body: unknown }[] = [];
  const looked: string[] = [];
  let failWith: string | null = null;
  let listFails = false;
  // Who can be asked in the new chat, as its hub says (it leaves the chat's own agent out): Codex, and Claude Code's work account.
  const row = (provider: string, account: string, handle: string, label: string) => ({ target: { provider, account, model: null, effort: null }, label, sub: "Plan", handle, paid: "no", local: false, available: true, why: null, typicalCostUsd: null });
  const choices = { choices: [row("codex", "default", "codex", "Codex · GPT-5.5"), row("claude", "work", "claude-work", "Claude Code · Opus 5.5")], machines: [] };
  replace("fetch", async (url: string, init?: RequestInit) => {
    const u = new URL(String(url));
    if (u.pathname === "/api/asks/targets") {
      looked.push(`${u.searchParams.get("room")} ${u.searchParams.get("machines")}`);
      return listFails ? new Response(JSON.stringify({ error: "Can't reach the hub." }), { status: 502 }) : new Response(JSON.stringify(choices));
    }
    posted.push({ url: String(url), body: JSON.parse(String(init?.body)) });
    return failWith ? new Response(JSON.stringify({ error: failWith }), { status: 413 }) : new Response(JSON.stringify({ id: "m1" }));
  });
  const { sendFirstMessage } = await import("./templateApi");
  const conn = { baseUrl: "http://hub", token: "t", deviceName: "Phone" };
  expect(await sendFirstMessage(conn, "r1", "Fix the login page.", "Claude Code")).toBeNull();
  expect(posted).toEqual([{ url: "http://hub/api/rooms/r1/messages", body: { text: "Fix the login page." } }]);
  expect(saved.size).toBe(0);
  // Nothing that looks like a name: who can be asked isn't looked up.
  expect(looked).toEqual([]);

  // It names another agent: others are asked about a message in the chat, and this one has none, so it waits in the message
  // box (where Send offers to take the name off, or send it as it is); nothing is sent from here.
  expect(await sendFirstMessage(conn, "r2", "@codex what do you think of the plan?", "Claude Code")).toBe(
    "Your first message names Codex, who can only be asked about a message in the chat. It's in the message box: take off @codex to send it to Claude Code.",
  );
  expect(looked).toEqual(["r2 1"]);
  expect(posted).toHaveLength(1);
  expect(saved.get("crosstalk.draft.r2")).toBe("@codex what do you think of the plan?");
  // Two of them; another account of the chat's own agent is named by its model.
  expect(await sendFirstMessage(conn, "r3", "@codex and @claude-work: which is faster?", "Claude Code")).toBe(
    "Your first message names Codex and Opus 5.5, who can only be asked about a message in the chat. It's in the message box: take off @codex and @claude-work to send it to Claude Code.",
  );

  // Only looks like a name (a package, an address, a name in code, or the chat's own agent): sent as it is.
  for (const [room, text] of [["r4", "Upgrade @types/react to 19."], ["r5", "Mail me at me@example.com, and see `@codex`."], ["r6", "@claude start with the tests."]]) {
    expect(await sendFirstMessage(conn, room, text, "Claude Code")).toBeNull();
    expect(posted.at(-1)).toEqual({ url: `http://hub/api/rooms/${room}/messages`, body: { text } });
    expect(saved.has(`crosstalk.draft.${room}`)).toBe(false);
  }
  // Who that is can't be told: never sent to the chat's agent while unsure.
  listFails = true;
  expect(await sendFirstMessage(conn, "r7", "Upgrade @types/react to 19.", "Codex")).toBe("Couldn't check who the @name in your first message is, so it's waiting in the message box. Send it from there.");
  expect(saved.get("crosstalk.draft.r7")).toBe("Upgrade @types/react to 19.");
  expect(posted).toHaveLength(4);

  // Refused: kept for the message box, with the hub's words.
  failWith = "message too long.";
  expect(await sendFirstMessage(conn, "r8", "Long one", "Codex")).toBe("The chat started, but its first message didn't go: message too long. It's waiting in the message box. Send it from there.");
  expect(saved.get("crosstalk.draft.r8")).toBe("Long one");
});
