import { expect, test } from "bun:test";
import { isServiceOnlyAgent } from "@crosstalk/shared";
import { ENDPOINT_PRESETS, KIMI_PRESET, SERVICE_PRESETS, presetNoteHolds, presetSteps, servicePreset } from "./presets";

test("the sheet lists the services the spec names, in its order, Kimi first", () => {
  expect(SERVICE_PRESETS.map((p) => p.title)).toEqual(["Kimi", "DeepSeek", "Mistral", "OpenRouter", "Groq", "xAI", "NanoGPT", "Refuseless", "Featherless", "Venice", "Google Gemini", "A server on this machine", "Another server"]);
  expect(new Set(SERVICE_PRESETS.map((p) => p.id)).size).toBe(SERVICE_PRESETS.length);
});

test("Kimi keeps the address and key page of the custom model dialog's preset", () => {
  const kimi = servicePreset("kimi")!;
  expect(kimi.baseUrl).toBe(KIMI_PRESET.baseUrl.codex!);
  expect(kimi.keyPage).toEqual(KIMI_PRESET.keyFrom);
  expect(kimi.label).toBe(KIMI_PRESET.label);
  // The older dialog still has its own list.
  expect(ENDPOINT_PRESETS.map((p) => p.id)).toEqual(["kimi"]);
});

test("a hosted service has an https address, a key page to open and no trailing slash or /v1", () => {
  const hosted = SERVICE_PRESETS.filter((p) => p.kind === "hosted");
  expect(hosted.map((p) => p.id)).toEqual(["kimi", "deepseek", "mistral", "openrouter", "groq", "xai", "nanogpt", "refuseless", "featherless", "venice", "gemini"]);
  for (const p of hosted) {
    expect(p.baseUrl.startsWith("https://")).toBe(true);
    expect(/\/v1$|\/$/.test(p.baseUrl)).toBe(false);
    expect(new URL(p.keyPage!.url).protocol).toBe("https:");
    // The link says where it goes: "Open platform.deepseek.com".
    expect(new URL(p.keyPage!.url).host.endsWith(p.keyPage!.label.split("/")[0])).toBe(true);
    if (p.docs) expect(new URL(p.docs.url).protocol).toBe("https:");
  }
});

test("only Gemini has a chat path of its own", () => {
  expect(SERVICE_PRESETS.filter((p) => p.chatPath).map((p) => [p.id, p.chatPath])).toEqual([["gemini", "/v1beta/openai/chat/completions"]]);
});

test("a server on this machine starts at a local address and another server starts empty; neither has a site to open", () => {
  const local = servicePreset("local")!;
  expect(new URL(local.baseUrl).hostname).toBe("127.0.0.1");
  expect(servicePreset("other")!.baseUrl).toBe("");
  for (const p of [local, servicePreset("other")!]) expect(p.keyPage).toBeUndefined();
});

test("Venice: its API address, its key page, and the one thing Crosstalk does for it", () => {
  const venice = servicePreset("venice")!;
  // Venice's own base address is https://api.venice.ai/api/v1; the chat path (/v1/chat/completions) is added to what's saved.
  expect(venice.baseUrl).toBe("https://api.venice.ai/api");
  expect(new URL(venice.baseUrl).host).toBe("api.venice.ai");
  expect(venice.chatPath).toBeUndefined();
  expect(venice.agent).toBe("codex"); // it speaks Chat Completions only, which Codex reaches through the adapter
  expect(venice.keyPage).toEqual({ label: "venice.ai/settings/api", url: "https://venice.ai/settings/api" });
  expect(venice.docs).toEqual({ label: "docs.venice.ai", url: "https://docs.venice.ai" });
  // What it is, in plain words, with what it costs.
  expect(venice.help).toBe("Privacy-first, uncensored models. Paid per use.");
  // Venice's own system prompt off, said in one short line, and its thinking kept out of the answer.
  expect(venice.extra).toEqual({ venice_parameters: { include_venice_system_prompt: false, strip_thinking_response: true } });
  expect(venice.note).toBe("Crosstalk turns Venice's own prompt off, so the agent follows its own instructions.");
  expect(venice.note!.length).toBeLessThan(90);
  // Venice has a Responses address as well, but only the chat lane goes through the adapter, where those fields are
  // added: the preset pins it, so what the note promises is what happens.
  expect(venice.protocol).toBe("chat");
  expect(presetSteps(venice)).toEqual(["Get a key at venice.ai/settings/api.", "Paste it here.", "Press Test."]);
  // It's the only preset that needs fields of its own in each request. A server on this machine pins the chat lane too
  // (these servers' Responses support is newer, and a model's chat template can refuse what an agent sends there), and
  // says so in its own note.
  expect(SERVICE_PRESETS.filter((p) => p.extra).map((p) => p.id)).toEqual(["venice"]);
  // Featherless pins it too: Chat Completions is the only lane it has (web/src/featherless.test.ts). NanoGPT pins it for
  // Codex so the adapter handles Codex's retries and measures its tool cost (web/src/nanogpt.test.ts).
  expect(SERVICE_PRESETS.filter((p) => p.protocol).map((p) => p.id)).toEqual(["nanogpt", "refuseless", "featherless", "venice", "local"]);
  expect(SERVICE_PRESETS.filter((p) => p.note).map((p) => p.id)).toEqual(["nanogpt", "refuseless", "featherless", "venice", "local"]);
  const local = servicePreset("local")!;
  expect([local.protocol, local.agent, local.kind]).toEqual(["chat", "codex", "local"]);
  expect(local.note).toBe("Crosstalk talks to it in the Chat Completions style, which these servers handle best.");
  expect(local.note!.length).toBeLessThan(90);
  // A pinned style has to be one a preset's own agent can speak, or it would never be used.
  // (Crosstalk's own agent and OpenCode speak Chat Completions only.)
  for (const p of SERVICE_PRESETS) if (p.protocol) expect(p.agent === "codex" ? ["responses", "chat"] : isServiceOnlyAgent(p.agent) ? ["chat"] : ["messages"]).toContain(p.protocol);
});

test("every preset has three short numbered steps, and a hosted one names where to get the key", () => {
  for (const p of SERVICE_PRESETS) {
    const steps = presetSteps(p);
    expect(steps).toHaveLength(3);
    expect(steps[2]).toBe("Press Test.");
    for (const s of steps) expect(s.length).toBeLessThan(80);
  }
  expect(presetSteps(servicePreset("deepseek")!)).toEqual(["Get a key at platform.deepseek.com.", "Paste it here.", "Press Test."]);
  expect(servicePreset("nope")).toBeNull();
  expect(servicePreset(null)).toBeNull();
});

test("a note that says which agent runs a service is shown only while that's true", () => {
  const refuseless = servicePreset("refuseless")!;
  const nano = servicePreset("nanogpt")!;
  const openCode = { opencode: {} };
  // Before a check has picked an agent: OpenCode has to be one this hub knows. A hub older than it doesn't list it.
  expect(presetNoteHolds(refuseless, null, openCode)).toBe(true);
  expect(presetNoteHolds(refuseless, null, {})).toBe(false);
  // Crosstalk's own agent is part of the hub.
  expect(presetNoteHolds(nano, null, {})).toBe(true);
  // Picked: only for the agent it's about.
  expect(presetNoteHolds(refuseless, "opencode", openCode)).toBe(true);
  for (const agent of ["builtin", "codex", "claude"] as const) expect(presetNoteHolds(refuseless, agent, openCode)).toBe(false);
  expect(presetNoteHolds(nano, "builtin", {})).toBe(true);
  for (const agent of ["opencode", "codex", "claude"] as const) expect(presetNoteHolds(nano, agent, openCode)).toBe(false);
  // Every other preset's note names no agent, and stays whichever is picked.
  for (const p of SERVICE_PRESETS.filter((x) => x.note && x.id !== "refuseless" && x.id !== "nanogpt")) expect(presetNoteHolds(p, "codex", {})).toBe(true);
});
