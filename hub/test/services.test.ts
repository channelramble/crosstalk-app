import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ModelCatalog, ServerEvent } from "@crosstalk/shared";
import { App } from "../src/app";
import { startServer } from "../src/server";
import { mayFollow } from "../src/serviceProbes";
import { fakeChatOnly, fakeLlamaCpp, fakeLmStudio, fakeMessagesOnly, fakeOllama, fakeResponsesOnly, fakeService, type Fake, type FakeOptions } from "./fixtures/fake-services";

const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
});

function setup() {
  const dir = mkdtempSync(join(tmpdir(), "ct-services-"));
  const app = new App({ dbPath: ":memory:", config: { port: 0, host: "127.0.0.1", publicUrl: null, workspaceRoot: dir, maxHopsDefault: 6 } });
  app.services.timeoutMs = 1500;
  cleanups.push(async () => {
    await app.engine.shutdown();
    app.store.close();
    rmSync(dir, { recursive: true, force: true });
  });
  return app;
}
const keep = <T extends Fake>(f: T): T => {
  cleanups.push(() => f.stop());
  return f;
};
const modelEvents = (app: App) => {
  const out: ModelCatalog[] = [];
  app.bus.on((e: ServerEvent) => {
    if (e.t === "models") out.push(e.catalog);
  });
  return out;
};
const unknown = { responses: "unknown", messages: "unknown", chat: "unknown" };

test("checking a service: which addresses it has, and how Crosstalk can run it, with free requests only", async () => {
  const app = setup();
  const cases = [
    { f: keep(fakeResponsesOnly()), protocols: { responses: "yes", messages: "no", chat: "no" }, works: [{ provider: "codex", via: "responses" }] },
    { f: keep(fakeMessagesOnly()), protocols: { responses: "no", messages: "yes", chat: "no" }, works: [{ provider: "claude", via: "messages" }] },
    { f: keep(fakeChatOnly()), protocols: { responses: "no", messages: "no", chat: "yes" }, works: [{ provider: "codex", via: "adapter" }] },
    { f: keep(fakeService()), protocols: { responses: "yes", messages: "yes", chat: "yes" }, works: [{ provider: "codex", via: "responses" }, { provider: "claude", via: "messages" }] },
  ];
  for (const c of cases) {
    const r = await app.services.test({ baseUrl: `${c.f.url}/v1/` }); // the dialog's "/v1" is cut off
    expect(r).toMatchObject({ reachable: true, authOk: true, server: null, protocols: c.protocols, works: c.works, problems: [] });
    expect(r.models.map((m) => m.id)).toEqual(["model-a", "model-b"]);
    // Only a GET for the list and POSTs of an empty object: never a model request.
    expect(c.f.seen.filter((s) => s.method === "POST").map((s) => [s.path, s.body]).sort()).toEqual([["/v1/chat/completions", "{}"], ["/v1/messages", "{}"], ["/v1/responses", "{}"]]);
    expect(c.f.seen.every((s) => s.method === "GET" || s.body === "{}")).toBe(true);
  }
  // Asked for an agent that can't use it, the answer names the one that can.
  const chatOnly = cases[2].f;
  expect((await app.services.test({ baseUrl: chatOnly.url, provider: "claude" })).problems).toEqual(["Claude Code can't use this server, but Codex can. Add it under Codex instead."]);
  expect((await app.services.test({ baseUrl: chatOnly.url, provider: "codex" })).problems).toEqual([]);
  await expect(app.services.test({ baseUrl: "" })).rejects.toThrow("Enter the model server's address");
});

test("checking a server tells what it is and reads each model's context where it says", async () => {
  const app = setup();
  const ollama = await app.services.test({ baseUrl: keep(fakeOllama()).url });
  expect(ollama).toMatchObject({ server: "Ollama", protocols: { responses: "yes", messages: "no", chat: "yes" }, works: [{ provider: "codex", via: "responses" }] });
  expect(ollama.models).toEqual([{ id: "llama3.2:3b", contextWindow: null }, { id: "qwen3:8b", contextWindow: 4096 }]); // only the loaded one says what it was given
  const lm = await app.services.test({ baseUrl: keep(fakeLmStudio()).url });
  expect(lm.server).toBe("LM Studio");
  expect(lm.models).toEqual([{ id: "qwen2.5-coder-7b", contextWindow: 8192 }, { id: "gemma-3-12b", contextWindow: 131072 }]); // loaded: what it has; the rest: the most it can
  const llama = await app.services.test({ baseUrl: keep(fakeLlamaCpp()).url });
  expect(llama.server).toBe("llama.cpp");
  expect(llama.models).toEqual([{ id: "qwen3.8-27b", contextWindow: 65536 }]); // /props, not the 262144 the model was trained on
  // Sizes the list itself carries: Moonshot, OpenRouter and xAI context_length, Mistral max_context_length, vLLM max_model_len, DeepSeek and Groq context_window.
  const hosted = keep(
    fakeService({ list: [{ id: "kimi", context_length: 262144 }, { id: "mistral", max_context_length: 131072 }, { id: "qwen", max_model_len: 32768 }, { id: "deepseek", context_window: 65536 }, { id: "embed", context_length: 512 }, { id: "silent" }] }),
  );
  expect((await app.services.test({ baseUrl: hosted.url })).models).toEqual([
    { id: "kimi", contextWindow: 262144 },
    { id: "mistral", contextWindow: 131072 },
    { id: "qwen", contextWindow: 32768 },
    { id: "deepseek", contextWindow: 65536 },
    { id: "embed", contextWindow: null }, // under 2,048: not a window a chat could use
    { id: "silent", contextWindow: null },
  ]);
  // The Check button of the custom-model dialog still answers as it did.
  expect(await app.providers.probeEndpoint(keep(fakeOllama()).url)).toMatchObject({ models: ["llama3.2:3b", "qwen3:8b"], contextWindow: 4096, server: "Ollama" });
  expect(await app.providers.probeEndpoint(keep(fakeLmStudio()).url)).toMatchObject({ contextWindow: 8192, server: "LM Studio" });
});

test("keys: a missing or refused key is said plainly, an account's saved key is used, and 401s alone prove nothing", async () => {
  const app = setup();
  const keyed = keep(fakeLlamaCpp({ key: "sk-good-key-123" })); // wants the key before it looks at anything
  const none = await app.services.test({ baseUrl: keyed.url });
  expect(none).toMatchObject({ reachable: true, authOk: false, models: [], works: [], protocols: unknown });
  expect(none.problems).toEqual(["This server wants an API key. Paste one in the key field."]);
  const wrong = await app.services.test({ baseUrl: keyed.url, apiKey: "sk-wrong-key" });
  expect(wrong).toMatchObject({ authOk: false, works: [], protocols: unknown });
  expect(wrong.problems).toEqual([`This key was refused. Check that you copied all of it, and that it is for 127.0.0.1:${keyed.port}.`]);
  const right = await app.services.test({ baseUrl: keyed.url, apiKey: " sk-good-key-123 " });
  expect(right).toMatchObject({ authOk: true, server: "llama.cpp", problems: [], works: [{ provider: "codex", via: "responses" }, { provider: "claude", via: "messages" }] });
  expect(keyed.seen.some((s) => s.auth === "Bearer sk-good-key-123")).toBe(true);

  // An existing account is checked with the key it has saved, at its own address when none is typed.
  const account = app.providers.setEndpointAccount("codex", { label: "Keyed", baseUrl: keyed.url, apiKey: "sk-good-key-123", models: ["qwen3.8-27b"] });
  expect(await app.services.test({ baseUrl: "", accountId: account.id })).toMatchObject({ authOk: true, server: "llama.cpp" });
  expect(await app.services.test({ baseUrl: keyed.url, accountId: account.id, provider: "codex" })).toMatchObject({ authOk: true });
  expect((await app.services.test({ baseUrl: keyed.url, accountId: account.id, apiKey: "sk-typed-wrong" })).authOk).toBe(false); // a typed key wins
  await expect(app.services.test({ baseUrl: keyed.url, accountId: "nothing" })).rejects.toThrow("No such custom model");
  // The saved key goes only to the account's own server: an address somewhere else gets none.
  const elsewhere = keep(fakeService());
  await app.services.test({ baseUrl: elsewhere.url, accountId: account.id });
  expect(elsewhere.seen.length).toBeGreaterThan(0);
  expect(elsewhere.seen.every((s) => s.auth === null)).toBe(true);

  // Anything but visible ASCII is turned away, in the check, the older Check button and the saved account: a space or line break
  // inside, and a "..." or dash from smart punctuation or a cut-off copy (fetch refuses those as a header, which read as "nothing answered").
  const asked = keyed.seen.length;
  for (const bad of ["sk bad\nkey", "sk-abc\u2026", "sk-abc\u2014def", "sk-caf\u00e9", "sk-del\u007f"]) {
    await expect(app.services.test({ baseUrl: keyed.url, apiKey: bad })).rejects.toThrow("Paste just the key");
    await expect(app.providers.probeEndpoint(keyed.url, bad)).rejects.toThrow("Paste just the key");
    expect(() => app.providers.setEndpointAccount("codex", { label: "Smart", baseUrl: keyed.url, apiKey: bad, models: ["m"] })).toThrow("Paste just the key");
  }
  expect(keyed.seen.length).toBe(asked); // none of them was sent anywhere
  expect(app.providers.accounts().some((a) => a.label === "Smart")).toBe(false); // nor saved
  expect(() => app.providers.setEndpointAccount("codex", { id: account.id, baseUrl: keyed.url, apiKey: "sk-new\u2026", models: ["qwen3.8-27b"] })).toThrow("Paste just the key");
  expect(await app.services.test({ baseUrl: "", accountId: account.id })).toMatchObject({ authOk: true }); // the saved key is still the good one

  // A server that looks at the address before the key: its 404s are real, so its 401s are too.
  const routeFirst = keep(fakeResponsesOnly({ key: "sk-other-key-1", routeFirst: true }));
  const r = await app.services.test({ baseUrl: routeFirst.url });
  expect(r).toMatchObject({ authOk: false, protocols: { responses: "yes", messages: "no", chat: "no" } });
  expect(r.problems).toEqual(["This server wants an API key. Paste one in the key field."]);
});

test("nothing answering, answering too slowly, odd answers and redirects", async () => {
  const app = setup();
  app.services.timeoutMs = 250;
  const gone = fakeService();
  const deadUrl = gone.url;
  gone.stop();
  const dead = await app.services.test({ baseUrl: deadUrl });
  expect(dead).toMatchObject({ reachable: false, authOk: null, models: [], works: [], protocols: unknown });
  expect(dead.problems).toEqual([`Nothing answered at ${deadUrl}. Check the address, and that the server is running.`]);

  const slow = keep(fakeService({ delayMs: 1500 }));
  const started = Date.now();
  const late = await app.services.test({ baseUrl: slow.url });
  expect(Date.now() - started).toBeLessThan(1200); // every probe runs at once under one time limit
  expect(late).toMatchObject({ reachable: false, authOk: null });
  expect(late.problems).toEqual([`127.0.0.1:${slow.port} didn't answer within 0.25 seconds. Check the address, and that the server is running.`]);

  // Anything but 400, 401, 403, 422 (there) and 404, 405 (not there) is odd: unknown, not guessed.
  const odd = keep(fakeService({ status: { "/v1/responses": 500, "/v1/messages": 200, "/v1/chat/completions": 429 } }));
  const oddResult = await app.services.test({ baseUrl: odd.url });
  expect(oddResult).toMatchObject({ reachable: true, authOk: true, protocols: unknown, works: [] });
  expect(oddResult.problems).toEqual([expect.stringContaining("answered oddly at /v1/responses (status 500)")]);
  const mixed = keep(fakeService({ status: { "/v1/responses": 422, "/v1/messages": 405 } }));
  expect(await app.services.test({ baseUrl: mixed.url })).toMatchObject({ protocols: { responses: "yes", messages: "no", chat: "yes" }, works: [{ provider: "codex", via: "responses" }] });
  const noModels = keep(fakeResponsesOnly({ listAt: "/not-the-list" }));
  const unlisted = await app.services.test({ baseUrl: noModels.url });
  expect(unlisted).toMatchObject({ authOk: null, models: [], works: [{ provider: "codex", via: "responses" }] });
  expect(unlisted.problems).toEqual(["This server doesn't list its models. Type the names of the ones you want to use."]);
  const empty = keep(fakeResponsesOnly({ list: [] }));
  expect((await app.services.test({ baseUrl: empty.url })).problems).toEqual(["This server lists no models yet. Load or pull one on the server, then test again."]);
  const noRoutes = keep(fakeService({ routes: [] }));
  const noRoutesProblems = (await app.services.test({ baseUrl: noRoutes.url })).problems;
  expect(noRoutesProblems).toEqual([expect.stringContaining("None of /v1/responses, /v1/messages, /v1/chat/completions answered here")]);
  expect(noRoutesProblems[0]).not.toContain("chat path");

  // A redirect is followed within the same host and port, not to another host or another port of the same host (and the key doesn't go there).
  const target = keep(fakeService());
  const moved = keep(fakeService({ redirect: { "/v1/responses": "/v1/chat/completions", "/v1/messages": `http://localhost:${target.port}/v1/messages` } }));
  const r = await app.services.test({ baseUrl: moved.url, apiKey: "sk-secret-0001" });
  expect(r.protocols).toMatchObject({ responses: "yes", messages: "unknown" });
  expect(target.seen).toEqual([]);
  const sidestep = keep(fakeService({ redirect: { "/v1/messages": `http://127.0.0.1:${target.port}/v1/messages` } })); // the same hostname, another port
  const s = await app.services.test({ baseUrl: sidestep.url, apiKey: "sk-secret-0002" });
  expect(s.protocols).toMatchObject({ responses: "yes", messages: "unknown", chat: "yes" });
  expect(sidestep.seen.some((q) => q.auth === "Bearer sk-secret-0002")).toBe(true);
  expect(target.seen).toEqual([]);
});

test("which redirects carry the key along: the same host and port, or the same host over https instead of http, never anywhere else", () => {
  const url = (u: string) => new URL(u);
  const follows = (from: string, to: string) => mayFollow(url(from), url(to));
  expect(follows("http://127.0.0.1:8080/v1/models", "http://127.0.0.1:8080/other")).toBe(true);
  expect(follows("https://api.example.com/v1/models", "https://api.example.com:443/v2/models")).toBe(true); // 443 is https's own port
  expect(follows("http://127.0.0.1:8080/v1/models", "http://127.0.0.1:8081/v1/models")).toBe(false); // another port is another server
  expect(follows("https://api.example.com/v1/models", "https://api.example.com:8443/v1/models")).toBe(false);
  expect(follows("http://127.0.0.1:8080/v1/models", "http://localhost:8080/v1/models")).toBe(false); // another host
  expect(follows("https://api.example.com/v1/models", "https://other.example.com/v1/models")).toBe(false);
  expect(follows("http://api.example.com/v1/models", "https://api.example.com/v1/models")).toBe(true); // up to https: the key is safer there
  expect(follows("http://api.example.com:8080/v1/models", "https://api.example.com:8443/v1/models")).toBe(true);
  expect(follows("http://api.example.com/v1/models", "https://other.example.com/v1/models")).toBe(false);
  expect(follows("https://api.example.com/v1/models", "http://api.example.com/v1/models")).toBe(false); // never down to http
  expect(follows("https://api.example.com:8443/v1/models", "http://api.example.com:8443/v1/models")).toBe(false);
});

test("a service with its own chat path: found from what's typed or saved, with its model list beside it", async () => {
  const app = setup();
  const gemini = keep(fakeChatOnly({ chatPath: "/v1beta/openai/chat/completions", listAt: "/v1beta/openai/models" }));
  const plain = await app.services.test({ baseUrl: gemini.url });
  expect(plain).toMatchObject({ reachable: true, works: [], models: [] });
  expect(plain.problems).toEqual(["This server doesn't list its models. Type the names of the ones you want to use.", expect.stringContaining("None of /v1/responses, /v1/messages, /v1/chat/completions answered here")]);
  expect(plain.problems.join(" ")).not.toContain("chat path"); // no screen has a chat path field to send someone to
  const typed = await app.services.test({ baseUrl: gemini.url, chatPath: "/v1beta/openai/chat/completions" });
  expect(typed).toMatchObject({ authOk: true, protocols: { responses: "no", messages: "no", chat: "yes" }, works: [{ provider: "codex", via: "adapter" }], problems: [] });
  expect(typed.models.map((m) => m.id)).toEqual(["model-a", "model-b"]);
  await expect(app.services.test({ baseUrl: gemini.url, chatPath: "chat" })).rejects.toThrow("starts with /");
  // Saved with the account, it's used when none is typed.
  const account = app.providers.setEndpointAccount("codex", { label: "Gemini", baseUrl: gemini.url, models: ["model-a"], protocol: "chat", chatPath: "/v1beta/openai/chat/completions" });
  expect((await app.services.test({ baseUrl: "", accountId: account.id })).works).toEqual([{ provider: "codex", via: "adapter" }]);
});

test("local servers: kinds, loaded models, memory, protocols and which accounts already use them", async () => {
  const app = setup();
  const ollama = keep(fakeOllama());
  const lm = keep(fakeLmStudio());
  const llama = keep(fakeLlamaCpp());
  const mlx = keep(fakeService({ list: [{ id: "mlx-community/Qwen3-4B-4bit" }], routes: ["chat"] })); // says nothing about what it is
  const vllm = keep(fakeService({ list: [{ id: "meta-llama/Llama-3.1-8B", owned_by: "vllm", max_model_len: 32768 }], routes: ["responses", "chat"] }));
  const locked = keep(fakeLlamaCpp({ key: "sk-locked-key-1" }));
  const notModels = keep(fakeService({ listAt: "/elsewhere" }));
  const gone = fakeService();
  const gonePort = gone.port;
  gone.stop();
  const ports = { [ollama.port]: "ollama", [lm.port]: "lmstudio", [llama.port]: "llamacpp", [mlx.port]: "mlx", [vllm.port]: "other", [locked.port]: "llamacpp", [notModels.port]: "ollama", [gonePort]: "ollama" } as const;
  const scan = { host: "127.0.0.1", ports, timeoutMs: 800 };
  const first = await app.services.localServers(scan);
  const by = (kind: string) => first.servers.find((s) => s.kind === kind)!;
  // Only what answers a model list: not a locked server, a server without one, or nothing. A server says what it is; the port's guess is for one that doesn't.
  expect(first.servers.map((s) => s.kind).sort()).toEqual(["llamacpp", "lmstudio", "mlx", "ollama", "vllm"]);
  expect(by("ollama")).toMatchObject({ id: `ollama-${ollama.port}`, label: `Ollama (port ${ollama.port})`, baseUrl: ollama.url, memoryBytes: 6_100_000_000, protocols: { responses: "yes", messages: "no", chat: "yes" }, accountIds: [] });
  // tools is null throughout: a local model server's list says nothing about tool calls (Venice's does, see below).
  expect(by("ollama").models).toEqual([
    { id: "llama3.2:3b", contextWindow: null, sizeBytes: 2_019_393_189, loaded: false, tools: null },
    { id: "qwen3:8b", contextWindow: 4096, sizeBytes: 5_200_000_000, loaded: true, tools: null },
  ]);
  expect(by("lmstudio")).toMatchObject({ memoryBytes: null, protocols: { responses: "yes", messages: "yes", chat: "yes" } });
  expect(by("lmstudio").models).toEqual([
    { id: "qwen2.5-coder-7b", contextWindow: 8192, sizeBytes: null, loaded: true, tools: null },
    { id: "gemma-3-12b", contextWindow: 131072, sizeBytes: null, loaded: false, tools: null },
  ]);
  expect(by("llamacpp").models).toEqual([{ id: "qwen3.8-27b", contextWindow: 65536, sizeBytes: 16_000_000_000, loaded: true, tools: null }]);
  expect(by("mlx")).toMatchObject({ label: `mlx-lm (port ${mlx.port})`, protocols: { responses: "no", messages: "no", chat: "yes" } });
  expect(by("mlx").models).toEqual([{ id: "mlx-community/Qwen3-4B-4bit", contextWindow: null, sizeBytes: null, loaded: false, tools: null }]);
  expect(by("vllm").models).toEqual([{ id: "meta-llama/Llama-3.1-8B", contextWindow: 32768, sizeBytes: null, loaded: true, tools: null }]);
  // Nothing was asked of a locked server beyond its list, and no model request went anywhere.
  expect(locked.seen.filter((s) => s.method === "POST")).toEqual([]);
  expect(first.servers.flatMap((s) => [s.baseUrl]).every((u) => u.startsWith("http://127.0.0.1:"))).toBe(true);

  // Accounts that point at a server (by this machine's own names for it) are named; this shows at once, though the look itself is kept 10 seconds.
  const codex = app.providers.setEndpointAccount("codex", { label: "Local Ollama", baseUrl: ollama.url, models: ["qwen3:8b"] });
  const claude = app.providers.setEndpointAccount("claude", { label: "Local Ollama", baseUrl: `http://localhost:${ollama.port}/v1`, models: ["qwen3:8b"] });
  app.providers.setEndpointAccount("codex", { label: "Behind a path", baseUrl: `${lm.url}/llm`, models: ["x"] }); // another server behind a proxy
  const probes = () => ollama.seen.filter((s) => s.method === "POST").length; // the look POSTs to each address once (the accounts above only GET)
  expect(probes()).toBe(3);
  const again = await app.services.localServers(scan);
  expect(again.scannedAt).toBe(first.scannedAt);
  expect(probes()).toBe(3); // the remembered look asked nothing
  expect(again.servers.find((s) => s.kind === "ollama")!.accountIds).toEqual(expect.arrayContaining([{ provider: "codex", id: codex.id }, { provider: "claude", id: claude.id }]));
  expect(again.servers.find((s) => s.kind === "ollama")!.accountIds).toHaveLength(2);
  expect(again.servers.find((s) => s.kind === "lmstudio")!.accountIds).toEqual([]);
  const fresh = await app.services.localServers({ ...scan, fresh: true });
  expect(fresh.scannedAt).toBeGreaterThanOrEqual(first.scannedAt);
  expect(probes()).toBe(6);
  // Another set of ports is a new look.
  expect((await app.services.localServers({ host: "127.0.0.1", ports: { [ollama.port]: "ollama" } })).servers.map((s) => s.kind)).toEqual(["ollama"]);
});

test("live model lists: the server's list, its contexts kept on the account, and the saved names when it can't be asked", async () => {
  const app = setup();
  const events = modelEvents(app);
  const llama = keep(fakeLlamaCpp());
  const account = app.providers.setEndpointAccount("codex", { label: "Local", baseUrl: llama.url, models: ["qwen3.8-27b", "saved-only"], contextWindow: 32768 });
  const first = await app.providers.models("codex", account.id);
  expect(first).toMatchObject({ live: true, error: null });
  // The saved models come first (the first is the default), each with its context: the server's, else the account's.
  expect(first.models.map((m) => [m.id, m.isDefault, m.contextWindow])).toEqual([["qwen3.8-27b", true, 65536], ["saved-only", false, 32768]]);

  // The server lists another model: refreshing finds it, keeps the contexts on the account, and tells the apps.
  llama.list.push({ id: "qwen3.8-coder", owned_by: "llamacpp" });
  events.length = 0;
  const refreshed = await app.services.refreshModels("codex", account.id);
  expect(refreshed?.endpoint).toMatchObject({ models: ["qwen3.8-27b", "saved-only"], contexts: { "qwen3.8-27b": 65536 } });
  expect((await app.providers.models("codex", account.id)).models.map((m) => m.id)).toEqual(["qwen3.8-27b", "saved-only", "qwen3.8-coder"]);
  expect(events.some((c) => c.accountId === account.id && c.models.length === 3)).toBe(true);
  // The pickers show the saved ones, and the server's others under More models.
  expect((await app.providers.models("codex", account.id)).models.map((m) => [m.id, m.more ?? false])).toEqual([["qwen3.8-27b", false], ["saved-only", false], ["qwen3.8-coder", true]]);

  // It stops answering: the list it gave stands but is no longer live (the phone says it couldn't reach it, and from when the list is),
  // the apps hear of it, and refreshing says why.
  const listedAt = (await app.providers.models("codex", account.id)).checkedAt!;
  expect(listedAt).toBeGreaterThan(0);
  llama.stop();
  events.length = 0;
  const down = await app.providers.models("codex", account.id, { fresh: true });
  expect(down.models.map((m) => m.id)).toEqual(["qwen3.8-27b", "saved-only", "qwen3.8-coder"]);
  expect(down.error).toContain("Nothing answered at");
  expect(down.live).toBe(false);
  expect(down.checkedAt).toBe(listedAt); // the last good answer, not now
  expect(events.map((c) => [c.accountId, c.live, c.checkedAt])).toEqual([[account.id, false, listedAt]]);
  expect(await app.providers.models("codex", account.id)).toMatchObject({ live: false, checkedAt: listedAt, error: down.error }); // kept for the retry wait
  await expect(app.services.refreshModels("codex", account.id)).rejects.toThrow("Nothing answered at");
  expect(await app.providers.models("codex", account.id, { fresh: true })).toMatchObject({ live: false, checkedAt: listedAt });
  expect(events).toHaveLength(1); // the same failure again is no news

  // An account never listed, on a server that's down: its saved names (with the sizes saved for them), and the note.
  const offline = app.providers.setEndpointAccount("claude", { label: "Offline", baseUrl: "http://127.0.0.1:1", models: ["m1", "m2"], contextWindow: 16384, contexts: { m1: 8192 } });
  const saved = await app.providers.models("claude", offline.id);
  expect(saved.live).toBe(false);
  expect(saved.checkedAt ?? 0).toBe(0); // never listed: nothing to say it was fetched, so no date to show
  expect(saved.error).toContain("Nothing answered at http://127.0.0.1:1");
  expect(saved.models.map((m) => [m.id, m.isDefault, m.contextWindow])).toEqual([["m1", true, 8192], ["m2", false, 16384]]);

  // A server without a model list has nothing to learn (the saved names stand, no note); one that refuses the key says so.
  const bare = keep(fakeService({ listAt: "/nothing" }));
  const bareAccount = app.providers.setEndpointAccount("codex", { label: "Bare", baseUrl: bare.url, models: ["only-one"] });
  expect(await app.providers.models("codex", bareAccount.id)).toMatchObject({ live: true, error: null, models: [{ id: "only-one", isDefault: true }] });
  const keyed = keep(fakeService({ key: "sk-right-key-12" }));
  const keyedAccount = app.providers.setEndpointAccount("codex", { label: "Keyed", baseUrl: keyed.url, apiKey: "sk-wrong-key-12", models: ["m"] });
  await expect(app.services.refreshModels("codex", keyedAccount.id)).rejects.toThrow("refused the key");
  expect(await app.services.refreshModels("claude", "nothing")).toBeNull();
});

test("a model under More models runs with the size its server lists, not the account's, after a restart too", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ct-services-more-"));
  const dbPath = join(dir, "hub.db");
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  const start = () => {
    const app = new App({ dbPath, config: { port: 0, host: "127.0.0.1", publicUrl: null, workspaceRoot: dir, maxHopsDefault: 6 } });
    app.services.timeoutMs = 1500;
    let open = true;
    const stop = async () => {
      if (!open) return;
      open = false;
      await app.engine.shutdown();
      app.store.close();
    };
    cleanups.push(stop);
    return { app, stop };
  };
  // OpenRouter style: the account was saved with the big model, and its server lists a small one and one it says nothing of.
  const router = keep(fakeService({ list: [{ id: "big-model", context_length: 200_000 }, { id: "small-model", context_length: 32_768 }, { id: "quiet-model" }] }));
  const { app, stop } = start();
  const account = app.providers.setEndpointAccount("codex", { label: "Router", baseUrl: router.url, models: ["big-model"], contextWindow: 200_000 });
  const listed = await app.providers.models("codex", account.id);
  expect(listed.models.map((m) => [m.id, m.more ?? false, m.contextWindow])).toEqual([["big-model", false, 200_000], ["small-model", true, 32_768], ["quiet-model", true, 200_000]]);
  // What the agent is given is what the picker says: the model's own size (Codex's window and where it compacts come from it).
  expect(app.endpointFor("codex", account.id, "small-model")?.contextWindow).toBe(32_768);
  expect(app.endpointFor("codex", account.id, "quiet-model")?.contextWindow).toBe(200_000); // the server says nothing: the account's
  expect(app.endpointFor("codex", account.id, "big-model")?.contextWindow).toBe(200_000);
  expect(app.endpointFor("codex", account.id, null)?.contextWindow).toBe(200_000);
  // The account itself keeps only its own models' sizes (what its settings dialog sends back).
  expect(app.providers.account("codex", account.id).endpoint?.contexts).toEqual({ "big-model": 200_000 });

  // After a restart, with the server down (nothing listed yet): still the small model's own size.
  await stop();
  router.stop();
  const again = start().app;
  expect(again.endpointFor("codex", account.id, "small-model")?.contextWindow).toBe(32_768);
  expect(again.endpointFor("codex", account.id, "big-model")?.contextWindow).toBe(200_000);
});

test("a server that fails after listing fine: the list stays, dated from its last good answer, and comes back live", async () => {
  const app = setup();
  const events = modelEvents(app);
  const server: FakeOptions = { status: { "/v1/models": 503 } }; // delete or set `status` to make it fail or answer
  const fake = keep(fakeService(server));
  const listAsks = () => fake.seen.filter((q) => q.method === "GET" && q.path === "/v1/models").length;
  const account = app.providers.setEndpointAccount("claude", { label: "Flaky", baseUrl: fake.url, models: ["model-a", "saved-only"] });

  // Never listed, and failing: the saved names, not live, with no time (it was never fetched).
  const first = await app.providers.models("claude", account.id);
  expect(first).toMatchObject({ live: false, error: "The server had a problem (error 503). Try again in a minute." });
  expect(first.models.map((m) => m.id)).toEqual(["model-a", "saved-only"]);
  expect(first.checkedAt ?? 0).toBe(0);

  // It answers: live, dated now, and the apps get the list.
  delete server.status;
  events.length = 0;
  const good = await app.providers.models("claude", account.id, { fresh: true });
  expect(good).toMatchObject({ live: true, error: null });
  expect(good.checkedAt).toBeGreaterThan(0);
  expect(good.models.map((m) => m.id)).toEqual(["model-a", "saved-only", "model-b"]);
  expect(events.map((c) => c.live)).toEqual([true]);

  // It fails with an error status (not silence): the same list, marked not live, still dated from the good answer; one event.
  server.status = { "/v1/models": 503 };
  events.length = 0;
  const bad = await app.providers.models("claude", account.id, { fresh: true });
  expect(bad).toMatchObject({ live: false, checkedAt: good.checkedAt, error: "The server had a problem (error 503). Try again in a minute." });
  expect(bad.models).toEqual(good.models);
  expect(events.map((c) => [c.live, c.error])).toEqual([[false, bad.error]]);
  // For the retry wait the answer comes from the hub's memory (the server is not asked on every request).
  const asks = listAsks();
  expect(await app.providers.models("claude", account.id)).toMatchObject({ live: false, checkedAt: good.checkedAt });
  expect(listAsks()).toBe(asks);

  // Failing in another way is news (the error changes); failing the same way again is not.
  server.status = { "/v1/models": 500 };
  expect(await app.providers.models("claude", account.id, { fresh: true })).toMatchObject({ live: false, checkedAt: good.checkedAt, error: "The server had a problem (error 500). Try again in a minute." });
  expect(events).toHaveLength(2);
  await app.providers.models("claude", account.id, { fresh: true });
  expect(events).toHaveLength(2);
  // A refused key is a failure of the same kind, and says so.
  server.status = { "/v1/models": 401 };
  expect(await app.providers.models("claude", account.id, { fresh: true })).toMatchObject({ live: false, checkedAt: good.checkedAt, error: expect.stringContaining("refused the key") });
  await expect(app.services.refreshModels("claude", account.id)).rejects.toThrow("refused the key");

  // It answers again: live, a newer time, no error, and the apps hear of it though the list is the same.
  delete server.status;
  events.length = 0;
  const back = await app.providers.models("claude", account.id, { fresh: true });
  expect(back).toMatchObject({ live: true, error: null });
  expect(back.checkedAt).toBeGreaterThanOrEqual(good.checkedAt!);
  expect(back.models).toEqual(good.models);
  expect(events.map((c) => c.live)).toEqual([true]);
  expect(await app.providers.models("claude", account.id)).toMatchObject({ live: true, error: null });
  expect((await app.services.refreshModels("claude", account.id))?.id).toBe(account.id);
});

test("an account saved before 0.4 still works, and the 0.4 fields are optional on a change", async () => {
  const app = setup();
  const llama = keep(fakeLlamaCpp());
  // What 0.3.1 wrote: none of protocol, chatPath or contexts.
  app.store.kvSet("accounts", JSON.stringify([{ provider: "codex", id: "old00001", label: "Old local", kind: "endpoint", baseUrl: llama.url, models: ["qwen3.8-27b"], contextWindow: 32768 }]));
  const old = app.providers.accounts().find((a) => a.id === "old00001")!;
  expect(old.endpoint).toEqual({ baseUrl: llama.url, models: ["qwen3.8-27b"], contextWindow: 32768, hasKey: false });
  expect(Object.keys(app.providers.endpointOf("codex", "old00001")!)).not.toEqual(expect.arrayContaining(["protocol"]));

  // Its list is live, and kept fresh in the background though this hub never saw the account's status.
  const events = modelEvents(app);
  expect((await app.providers.models("codex", "old00001")).models[0].contextWindow).toBe(65536);
  llama.list.push({ id: "second", owned_by: "llamacpp" });
  await app.providers.refreshModels();
  expect(events.some((c) => c.models.some((m) => m.id === "second"))).toBe(true);
  expect(await app.services.test({ baseUrl: "", accountId: "old00001" })).toMatchObject({ reachable: true, server: "llama.cpp" });

  // A change from an app that doesn't know the new fields leaves them alone; null takes one away.
  const set = (extra: Record<string, unknown> = {}) => app.providers.setEndpointAccount("codex", { id: "old00001", baseUrl: llama.url, models: ["qwen3.8-27b", "second"], contextWindow: 32768, ...extra }).endpoint!;
  expect(set()).toEqual({ baseUrl: llama.url, models: ["qwen3.8-27b", "second"], contextWindow: 32768, hasKey: false, contexts: { "qwen3.8-27b": 65536 } }); // the context the server gave was kept by the refresh
  expect(set({ protocol: "chat", chatPath: "/v1/chat/completions", contexts: { second: 8192 } })).toMatchObject({ protocol: "chat", chatPath: "/v1/chat/completions", contexts: { second: 8192 } });
  expect(set()).toMatchObject({ protocol: "chat", chatPath: "/v1/chat/completions", contexts: { second: 8192 } });
  const cleared = set({ protocol: null, chatPath: null, contexts: null });
  expect(cleared).toEqual({ baseUrl: llama.url, models: ["qwen3.8-27b", "second"], contextWindow: 32768, hasKey: false });
});

test("the new account fields are checked before anything is saved", () => {
  const app = setup();
  const base = { baseUrl: "http://127.0.0.1:9", models: ["m"] };
  const bad = (p: "codex" | "claude", extra: Record<string, unknown>, message: string) => expect(() => app.providers.setEndpointAccount(p, { ...base, ...extra })).toThrow(message);
  bad("claude", { protocol: "chat" }, "Only Codex can use a server that speaks just chat completions");
  bad("codex", { protocol: "soap" }, "one of responses, messages or chat");
  for (const chatPath of ["chat/completions", "/v1/chat?x=1", "/a b", 7, "/" + "a".repeat(300)]) bad("codex", { chatPath }, "starts with /");
  const tooMany = Object.fromEntries(Array.from({ length: 101 }, (_, i) => [`m${i}`, 4096]));
  for (const contexts of [{ m: 100 }, { m: "big" }, { m: 4096.5 }, { m: 20_000_000 }, { "": 4096 }, { "a b": 4096 }, ["m"], "m", tooMany]) bad("codex", { contexts }, "Context sizes are model names");
  expect(app.providers.accounts().filter((a) => a.kind === "endpoint")).toEqual([]);
  const ok = app.providers.setEndpointAccount("codex", { ...base, protocol: "chat", chatPath: "/v1beta/openai/chat/completions", contexts: { m: 32768 } });
  expect(ok.endpoint).toMatchObject({ protocol: "chat", chatPath: "/v1beta/openai/chat/completions", contexts: { m: 32768 } });
  expect(app.providers.setEndpointAccount("claude", { ...base, label: "Claude", protocol: "messages" }).endpoint).toMatchObject({ protocol: "messages" });
});

test("the routes: checking a service, local servers, refreshing a list and saving the new fields", async () => {
  const app = setup();
  const server = startServer(app);
  cleanups.push(() => void server.stop(true));
  const base = `http://127.0.0.1:${server.port}`;
  const device = (await app.auth.pair((await app.auth.createPairingCode()).code, "T", "Web"))!;
  const call = async (method: string, path: string, body?: unknown) => {
    const r = await fetch(base + path, { method, headers: { authorization: `Bearer ${device.token}`, "content-type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
    return { status: r.status, body: (await r.json().catch(() => null)) as any };
  };
  const llama = keep(fakeLlamaCpp());
  const chatOnly = keep(fakeChatOnly());

  const checked = await call("POST", "/api/services/test", { baseUrl: llama.url, provider: "claude" });
  expect(checked.status).toBe(200);
  expect(checked.body).toMatchObject({ reachable: true, server: "llama.cpp", works: [{ provider: "codex", via: "responses" }, { provider: "claude", via: "messages" }], problems: [] });
  expect((await call("POST", "/api/services/test", { baseUrl: "" })).status).toBe(400);
  expect((await call("POST", "/api/services/test", { baseUrl: llama.url, chatPath: "nope" })).status).toBe(400);

  expect((await call("POST", "/api/accounts/endpoint", { provider: "claude", baseUrl: chatOnly.url, models: ["model-a"], protocol: "chat" })).status).toBe(400);
  const saved = await call("POST", "/api/accounts/endpoint", { provider: "codex", label: "Chat only", baseUrl: chatOnly.url, models: ["model-a"], protocol: "chat", chatPath: "/v1/chat/completions", contexts: { "model-a": 16384 } });
  expect(saved.status).toBe(200);
  expect(saved.body.endpoint).toMatchObject({ protocol: "chat", chatPath: "/v1/chat/completions", contexts: { "model-a": 16384 } });

  const refreshed = await call("POST", `/api/accounts/codex/${saved.body.id}/refresh-models`);
  expect(refreshed.status).toBe(200);
  expect(refreshed.body).toMatchObject({ id: saved.body.id, kind: "endpoint" });
  expect((await call("POST", "/api/accounts/codex/nothing/refresh-models")).status).toBe(404);
  expect((await call("POST", `/api/accounts/muse/${saved.body.id}/refresh-models`)).status).toBe(400);
  chatOnly.stop();
  const failed = await call("POST", `/api/accounts/codex/${saved.body.id}/refresh-models`);
  expect(failed.status).toBe(502);
  expect(failed.body.error).toContain("Nothing answered at");

  app.services.scanOptions = { ports: { [llama.port]: "llamacpp" } };
  const scan = await call("GET", "/api/local-servers");
  expect(scan.status).toBe(200);
  expect(scan.body.servers.map((s: { kind: string }) => s.kind)).toEqual(["llamacpp"]);
  expect(typeof scan.body.scannedAt).toBe("number");
  // The test hubs look nowhere on the real machine: CROSSTALK_LOCAL_SERVER_PORTS replaces the usual ports (empty: none).
  app.services.scanOptions = {};
  const portsBefore = process.env.CROSSTALK_LOCAL_SERVER_PORTS;
  try {
    process.env.CROSSTALK_LOCAL_SERVER_PORTS = "";
    expect((await call("GET", "/api/local-servers?fresh=1")).body.servers).toEqual([]);
    process.env.CROSSTALK_LOCAL_SERVER_PORTS = ` ${llama.port}:llamacpp, 1:nonsense `;
    expect((await call("GET", "/api/local-servers?fresh=1")).body.servers.map((s: { kind: string }) => s.kind)).toEqual(["llamacpp"]);
  } finally {
    if (portsBefore === undefined) delete process.env.CROSSTALK_LOCAL_SERVER_PORTS;
    else process.env.CROSSTALK_LOCAL_SERVER_PORTS = portsBefore;
  }
  for (const [method, path] of [["GET", "/api/local-servers"], ["POST", "/api/services/test"], ["POST", "/api/accounts/codex/x/refresh-models"]]) expect((await fetch(base + path, { method })).status).toBe(401);
});
