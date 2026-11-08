import { expect, test } from "bun:test";
import { App } from "../src/app";

// What a driver is given for a custom-model account (App.endpointFor): per-model context windows, and the translator's
// address and key (never the real key) for a server that only speaks Chat Completions.
function hub() {
  return new App({ dbPath: ":memory:", config: { port: 0, host: "127.0.0.1", publicUrl: null, workspaceRoot: "/tmp", maxHopsDefault: 5 } });
}

test("a model with its own context window gets it; the others get the account's", async () => {
  const app = hub();
  try {
    const acct = app.providers.setEndpointAccount("codex", { label: "Local", baseUrl: "http://127.0.0.1:9", apiKey: "real-key-1", models: ["big", "small"], contextWindow: 1_000_000, contexts: { small: 32_768 } });
    expect(app.endpointFor("codex", acct.id, "small")?.contextWindow).toBe(32_768);
    expect(app.endpointFor("codex", acct.id, "big")?.contextWindow).toBe(1_000_000);
    expect(app.endpointFor("codex", acct.id, null)?.contextWindow).toBe(1_000_000);
    expect(app.endpointFor("codex", "default")).toBeNull();
  } finally {
    await app.shutdown();
  }
});

test("a server that only speaks Chat Completions is reached through the translator, and never with the real key", async () => {
  const app = hub();
  try {
    const acct = app.providers.setEndpointAccount("codex", { label: "Gemini", baseUrl: "https://upstream.example.com", apiKey: "real-key-2", models: ["g1"], contextWindow: 65_536, protocol: "chat" });
    // The translator can't give an address (it isn't running): refuse, never hand the agent the real address and key.
    app.adapter.urlFor = () => null;
    expect(() => app.endpointFor("codex", acct.id, "g1")).toThrow(/Gemini only speaks an older style/);
    // With the translator's address and its own token, that is what the agent gets.
    app.adapter.urlFor = () => ({ baseUrl: "http://127.0.0.1:9123/a/x", key: "adapter-token" });
    const via = app.endpointFor("codex", acct.id, "g1");
    expect(via).toMatchObject({ baseUrl: "http://127.0.0.1:9123/a/x", key: "adapter-token", contextWindow: 65_536 });
    expect(JSON.stringify(via)).not.toContain("real-key-2");
    expect(JSON.stringify(via)).not.toContain("upstream.example.com");
  } finally {
    await app.shutdown();
  }
});

test("an ordinary custom-model account keeps its own address and key when the translator has nothing for it", async () => {
  const app = hub();
  try {
    const acct = app.providers.setEndpointAccount("codex", { label: "Kimi", baseUrl: "https://api.example.com", apiKey: "real-key-3", models: ["k"] });
    app.adapter.urlFor = () => null;
    expect(app.endpointFor("codex", acct.id, "k")).toMatchObject({ baseUrl: "https://api.example.com", key: "real-key-3" });
  } finally {
    await app.shutdown();
  }
});
