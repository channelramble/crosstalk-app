// Starting a chat on an AI service: one you've added, and a model server running on this machine that isn't added yet
// (the New chat menu offers both). The server is checked and added exactly as Settings → AI services would have added
// it, then the chat starts on it — in one call, so a chat is never left without its service or the other way round.

import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { memberAccount, SERVICE_MAX_MODELS } from "@crosstalk/shared";
import { App } from "../src/app";
import { startServer } from "../src/server";
import { fakeChatOnly, fakeLlamaCpp, fakeMessagesOnly, fakeService, type Fake } from "./fixtures/fake-services";

const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
});

function setup() {
  const dir = mkdtempSync(join(tmpdir(), "ct-service-chats-"));
  const app = new App({ dbPath: ":memory:", config: { port: 0, host: "127.0.0.1", publicUrl: null, workspaceRoot: dir, maxHopsDefault: 6 } });
  app.services.timeoutMs = 1500;
  const server = startServer(app);
  cleanups.push(async () => {
    server.stop(true);
    await app.engine.shutdown();
    app.store.close();
    rmSync(dir, { recursive: true, force: true });
  });
  return { app, port: server.port as number };
}

const keep = <T extends Fake>(f: T): T => {
  cleanups.push(() => f.stop());
  return f;
};

/** A phone's calls to the hub. */
async function caller(app: App, port: number) {
  const device = (await app.auth.pair((await app.auth.createPairingCode()).code, "T", "Web"))!;
  return async (method: string, path: string, body?: unknown) => {
    const r = await fetch(`http://127.0.0.1:${port}${path}`, {
      method,
      headers: { authorization: `Bearer ${device.token}`, "content-type": "application/json" },
      body: body ? JSON.stringify(body) : undefined,
    });
    return { status: r.status, body: (await r.json().catch(() => null)) as any }; // eslint-disable-line @typescript-eslint/no-explicit-any
  };
}

test("a chat on a service you've added: its agent runs on that account, with the model picked", async () => {
  const { app, port } = setup();
  const call = await caller(app, port);
  const llama = keep(fakeLlamaCpp());
  const account = app.providers.setEndpointAccount("codex", { label: "Qwen here", baseUrl: llama.url, apiKey: "", models: ["qwen3.8-27b"], contextWindow: 65536 });

  // The New chat dialog's own route, with the service as the account: what it has always sent, now from the menu.
  const plain = await call("POST", "/api/chats", { provider: "codex", account: account.id, model: "qwen3.8-27b", name: "Local chat" });
  expect(plain.status).toBe(200);
  const member = app.store.listMembers(plain.body.id)[0];
  expect([member.provider, memberAccount(member), member.model]).toEqual(["codex", account.id, "qwen3.8-27b"]);

  // The service route takes an account too, and fills in the service's own default model when none is asked for.
  const viaService = await call("POST", "/api/chats/service", { account: account.id, provider: "codex", name: "Another" });
  expect(viaService.status).toBe(200);
  expect(viaService.body.added).toBe(false);
  expect(viaService.body.account.id).toBe(account.id);
  const second = app.store.listMembers(viaService.body.room.id)[0];
  expect([second.provider, memberAccount(second), second.model]).toEqual(["codex", account.id, "qwen3.8-27b"]);

  // A service that isn't here any more says so, with where to add it again, and makes no chat.
  const gone = await call("POST", "/api/chats/service", { account: "nothing" });
  expect(gone.status).toBe(404);
  expect(gone.body.error).toContain("Settings → AI services");
  expect(app.store.listRooms()).toHaveLength(2);
});

test("a server on this machine that isn't added yet: one call checks it, adds it as Settings would, and starts the chat", async () => {
  const { app, port } = setup();
  const call = await caller(app, port);
  const llama = keep(fakeLlamaCpp());
  app.services.scanOptions = { ports: { [llama.port]: "llamacpp" } };

  const started = await call("POST", "/api/chats/service", { baseUrl: llama.url, label: `llama.cpp (port ${llama.port})`, name: "Qwen" });
  expect(started.status).toBe(200);
  expect(started.body.added).toBe(true);
  // The same account Settings → AI services makes from Found on this machine → Use it: the name the scan gave it, every
  // model it listed, the context its /props reported, and the lane that preset pins — the translator, even though this
  // server's Responses address answered too (a model's chat template can refuse what an agent sends there).
  expect(started.body.account).toMatchObject({ provider: "codex", kind: "endpoint", label: `llama.cpp (port ${llama.port})`, plan: "Custom model" });
  expect(started.body.account.endpoint).toMatchObject({ baseUrl: llama.url, models: ["qwen3.8-27b"], contextWindow: 65536, contexts: { "qwen3.8-27b": 65536 }, hasKey: false });
  expect(started.body.account.endpoint.protocol).toBe("chat");
  expect(app.providers.endpointOf("codex", started.body.account.id)).toMatchObject({ baseUrl: llama.url });
  // The chat is on it, on its model.
  const member = app.store.listMembers(started.body.room.id)[0];
  expect([member.provider, memberAccount(member), member.model]).toEqual(["codex", started.body.account.id, "qwen3.8-27b"]);
  expect(started.body.room.name).toBe("Qwen");
  // Nothing was ever asked to run a model: only the free check (a GET of the list, and `{}` POSTs).
  expect(llama.seen.every((s) => s.method === "GET" || s.body === "{}")).toBe(true);

  // Tapped again (two devices, a double tap): the account that already points there is used, not a second one.
  const again = await call("POST", "/api/chats/service", { baseUrl: llama.url, label: `llama.cpp (port ${llama.port})` });
  expect(again.status).toBe(200);
  expect(again.body.added).toBe(false);
  expect(again.body.account.id).toBe(started.body.account.id);
  expect(app.providers.accounts().filter((a) => a.kind === "endpoint")).toHaveLength(1);

  // Without a name from the app, the hub gives it the one this machine's own scan has for that server.
  const other = keep(fakeLlamaCpp());
  app.services.scanOptions = { ports: { [other.port]: "llamacpp" }, fresh: true };
  const unnamed = await call("POST", "/api/chats/service", { baseUrl: other.url });
  expect(unnamed.status).toBe(200);
  expect(unnamed.body.account.label).toBe(`llama.cpp (port ${other.port})`);
});

test("a server added this way is held to the translator, however its address is written", async () => {
  const { app, port } = setup();
  const call = await caller(app, port);
  const service = keep(fakeService());
  // The check itself still says what the server has: only the lane the account is saved with is pinned.
  expect((await app.services.test({ baseUrl: service.url })).works[0]).toEqual({ provider: "codex", via: "responses" });
  const named = await call("POST", "/api/chats/service", { baseUrl: service.url.replace("127.0.0.1", "localhost"), label: "By name" });
  expect(named.body.account.endpoint.protocol).toBe("chat");
  // The same lane whatever the address looks like — the sheet's "A server on this machine" pins it by the preset, not by
  // the address (web/src/services.ts protocolFor), so the two ways of adding can't disagree. 0.0.0.0 reaches the same
  // loopback server while reading as no local address at all.
  const other = keep(fakeService());
  const odd = await call("POST", "/api/chats/service", { baseUrl: `http://0.0.0.0:${other.port}`, label: "Any address" });
  expect(odd.status).toBe(200);
  expect(odd.body.account.endpoint.protocol).toBe("chat");
});

test("a one-tap service chat takes no effort or helper model from another account's defaults", async () => {
  const { app, port } = setup();
  const call = await caller(app, port);
  const llama = keep(fakeLlamaCpp());
  // Codex's own defaults, made for its own sign-in: a model, an effort and a helper model that only OpenAI serves.
  app.setAgentDefaults("codex", { account: "default", model: "gpt-5.1-codex", effort: "high", helperModel: "gpt-5.1-codex-mini", permissionMode: "ask" });

  const started = await call("POST", "/api/chats/service", { baseUrl: llama.url, label: "Qwen here" });
  expect(started.status).toBe(200);
  const member = app.store.listMembers(started.body.room.id)[0];
  // The service's own model, and nothing of the other account's: a helper held to a model this server doesn't serve
  // would fail every spawn, and an effort chosen for another model isn't this one's.
  expect(member.model).toBe("qwen3.8-27b");
  expect(member.config).toEqual({ account: started.body.account.id });
  // The permissions are still yours, and the defaults' own account keeps its model, effort and helper.
  expect(member.permissionMode).toBe("ask");
  const own = await call("POST", "/api/chats", { provider: "codex" });
  expect(app.store.listMembers(own.body.id)[0]).toMatchObject({ model: "gpt-5.1-codex", config: { effort: "high", helperModel: "gpt-5.1-codex-mini" } });
});

test("the agent and the lane follow the check: a chat-only server goes to Codex through the translator, a Messages one to Claude Code", async () => {
  const { app, port } = setup();
  const call = await caller(app, port);
  const chatOnly = keep(fakeChatOnly());
  const messages = keep(fakeMessagesOnly());

  const chat = await call("POST", "/api/chats/service", { baseUrl: chatOnly.url, label: "Chat only" });
  expect(chat.status).toBe(200);
  expect(chat.body.account).toMatchObject({ provider: "codex" });
  expect(chat.body.account.endpoint).toMatchObject({ protocol: "chat" });

  const claude = await call("POST", "/api/chats/service", { baseUrl: messages.url, label: "Messages only" });
  expect(claude.status).toBe(200);
  expect(claude.body.account).toMatchObject({ provider: "claude" });
  expect(claude.body.account.endpoint).toMatchObject({ protocol: "messages" });
  expect(app.store.listMembers(claude.body.room.id)[0].provider).toBe("claude");

  // The agent the app asked for is honoured when it can run the server.
  const asked = await call("POST", "/api/chats/service", { baseUrl: keep(fakeService()).url, label: "Both ways", provider: "claude" });
  expect(asked.body.account.provider).toBe("claude");
});

test("a check that found nothing usable says why and what to do, and starts no chat", async () => {
  const { app, port } = setup();
  const call = await caller(app, port);

  // Nothing listening there.
  const nowhere = await call("POST", "/api/chats/service", { baseUrl: "http://127.0.0.1:1" });
  expect(nowhere.status).toBe(400);
  expect(nowhere.body.error).toContain("Check the address, and that the server is running");

  // A server with a model list but none of the three addresses: it says which addresses were tried.
  const useless = keep(fakeService({ routes: [] }));
  const refused = await call("POST", "/api/chats/service", { baseUrl: useless.url, label: "Useless" });
  expect(refused.status).toBe(400);
  expect(refused.body.error).toContain("/v1/responses");

  // A server that wants a key it wasn't given says so, with where to put one.
  const keyed = keep(fakeLlamaCpp({ key: "sk-good" }));
  const locked = await call("POST", "/api/chats/service", { baseUrl: keyed.url, label: "Keyed" });
  expect(locked.status).toBe(400);
  expect(locked.body.error).toContain("API key");
  const withKey = await call("POST", "/api/chats/service", { baseUrl: keyed.url, label: "Keyed", apiKey: "sk-good" });
  expect(withKey.status).toBe(200);
  expect(withKey.body.account.endpoint.hasKey).toBe(true);

  expect(app.store.listRooms()).toHaveLength(1); // only the keyed one's
  expect(app.providers.accounts().filter((a) => a.kind === "endpoint")).toHaveLength(1);
  expect(await call("POST", "/api/chats/service", { baseUrl: "" }).then((r) => r.status)).toBe(400);
});

test("models that can't run tools are left out of the account, but one asked for is kept", async () => {
  const { app, port } = setup();
  const call = await caller(app, port);
  // A Venice-shaped list: two models that can run tool calls, two that say they can't.
  const venice = keep(
    fakeService({
      list: [
        { id: "tools-a", model_spec: { capabilities: { supportsFunctionCalling: true } } },
        { id: "talker", model_spec: { capabilities: { supportsFunctionCalling: false } } },
        { id: "tools-b", model_spec: { capabilities: { supportsFunctionCalling: true } } },
        { id: "talker-2", model_spec: { capabilities: { supportsFunctionCalling: false } } },
      ],
    }),
  );
  // One the user picked anyway (a model that can only talk) is saved alongside the ones that can work, and the chat
  // runs on it; a tool-capable model stays the account's default.
  const added = await call("POST", "/api/chats/service", { baseUrl: venice.url, label: "Venice-ish", model: "talker" });
  expect(added.status).toBe(200);
  expect(added.body.account.endpoint.models).toEqual(["tools-a", "tools-b", "talker"]);
  expect(app.store.listMembers(added.body.room.id)[0].model).toBe("talker");

  // A service whose every model says it can't run tools still starts a chat, on the one asked for.
  const talker = keep(fakeService({ list: [{ id: "talker", model_spec: { capabilities: { supportsFunctionCalling: false } } }] }));
  const chat = await call("POST", "/api/chats/service", { baseUrl: talker.url, label: "Talker", model: "talker" });
  expect(chat.status).toBe(200);
  expect(chat.body.account.endpoint.models).toEqual(["talker"]);
  expect(app.store.listMembers(chat.body.room.id)[0].model).toBe("talker");
});

test("a long model list is cleaned and cut the way the Settings sheet cleans and cuts it", async () => {
  const { app, port } = setup();
  const call = await caller(app, port);
  // A list the sheet would hand you to pick from (more than SERVICE_MAX_MODELS): nobody is here to pick, so the first
  // 20 that can run tools are saved and the rest are the chat's "More models" — not one lone model.
  const many = keep(fakeService({ list: Array.from({ length: 25 }, (_, i) => ({ id: `m${i}` })) }));
  const long = await call("POST", "/api/chats/service", { baseUrl: many.url, label: "Many" });
  expect(long.status).toBe(200);
  expect(long.body.account.endpoint.models).toHaveLength(SERVICE_MAX_MODELS);
  expect(long.body.account.endpoint.models.slice(0, 3)).toEqual(["m0", "m1", "m2"]);

  // A name with a space in it is no name an agent can pass: the sheet drops it before counting, so this list of 21 is
  // the 20 the sheet would have ticked, all of them saved.
  const spaced = keep(fakeService({ list: [...Array.from({ length: 20 }, (_, i) => ({ id: `n${i}` })), { id: "not a model name" }] }));
  const cleaned = await call("POST", "/api/chats/service", { baseUrl: spaced.url, label: "Spaced" });
  expect(cleaned.status).toBe(200);
  expect(cleaned.body.account.endpoint.models).toEqual(Array.from({ length: 20 }, (_, i) => `n${i}`));
});
