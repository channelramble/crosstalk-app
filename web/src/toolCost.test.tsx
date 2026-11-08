import { expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { AgentAccount, ModelOption, ToolCost } from "@crosstalk/shared";

// What Codex's tools cost on a model, where a person actually reads it: the help under the model picker, and the service's own
// row in Settings → AI services. The figure comes from a request that really went through the chat adapter
// (hub/src/adapter/cost.ts), so a model no chat has used says nothing here.

// The app's store reads a few browser globals when it loads; give it just enough to import in a test.
const g = globalThis as Record<string, unknown>;
g.location ??= { hash: "", href: "http://test/", origin: "http://test" };
g.window ??= Object.assign(globalThis, { addEventListener() {}, removeEventListener() {} });
g.localStorage ??= { getItem: () => null, setItem() {}, removeItem() {} };
g.navigator ??= { userAgent: "test" };
g.document ??= { addEventListener() {}, removeEventListener() {}, visibilityState: "visible", querySelector: () => null };
g.matchMedia ??= () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
const { AgentOptions } = await import("./views/AgentOptions");
const { ServiceRow } = await import("./views/AiServices");

/** The words on screen: tags stripped, entities read. */
const words = (html: string) => html.replace(/<[^>]+>/g, " ").replace(/&#x27;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, "&").replace(/&#x2192;/g, "→").replace(/\s+/g, " ").trim();

/** Measured figures: 361 tools and 133,500 tokens of schemas for a first "hi!", against a 16k local model. */
const cost = (over: Partial<ToolCost> = {}): ToolCost => ({ at: Date.now(), model: "qwen3-8b", tools: 133_500, toolCount: 361, prompt: 141_085, window: 16_384, dropped: 343, ...over });
const model = (over: Partial<ModelOption> = {}): ModelOption => ({ id: "qwen3-8b", label: "qwen3-8b", description: "On Qwen here", efforts: [], defaultEffort: null, isDefault: true, contextWindow: 16_384, ...over });

const picker = (models: ModelOption[]) =>
  words(
    renderToStaticMarkup(
      createElement(AgentOptions, {
        provider: "codex",
        value: { account: "qwen1", model: models[0].id, effort: "", permissionMode: "ask" as const },
        onChange: () => {},
        offer: models,
        showAccount: false,
        showPermissions: false,
        showHelpers: false,
      }),
    ),
  );

const account = (over: Partial<AgentAccount["endpoint"]> | null): AgentAccount => ({
  provider: "codex",
  id: "qwen1",
  label: "Qwen here",
  kind: "endpoint",
  workspaceId: null,
  endpoint: over === null ? null : { baseUrl: "http://127.0.0.1:8080", models: ["qwen3-8b"], contextWindow: 16_384, hasKey: false, protocol: "chat", ...over },
  signedIn: true,
  account: null,
  plan: "Custom model",
  authMethod: null,
  error: null,
  checkedAt: Date.now(),
});
const row = (a: AgentAccount) => words(renderToStaticMarkup(createElement(ServiceRow, { account: a })));

test("the model picker says what the tools cost on the model that was measured, and when", () => {
  const shown = picker([model({ toolCost: cost() })]);
  expect(shown).toContain("Codex's tools take about 134,000 tokens; this model holds 16,384.");
  expect(shown).toContain("Crosstalk leaves 343 of them out so a chat can start.");
  expect(shown).toContain("Measured today.");
  // It sits with the model's own help (its description and what it holds).
  expect(shown).toContain("On Qwen here · 16k context");
  // A model with no room for Codex's own prompt at all says that too, above the measurement: the two answer different
  // questions ("it can't work" and "this is what it would cost").
  const tiny = picker([model({ id: "qwen3-1.7b", label: "qwen3-1.7b", contextWindow: 8_192, toolCost: cost({ model: "qwen3-1.7b", window: 8_192 }) })]);
  expect(tiny).toContain("Codex's own instructions and tools need about 12,000");
  expect(tiny).toContain("Codex's tools take about 134,000 tokens; this model holds 8,192.");
  expect(tiny.indexOf("no room left to answer in")).toBeLessThan(tiny.indexOf("Codex's tools take about"));
});

test("a model nothing has been measured on says nothing, and neither does one with room to spare", () => {
  expect(picker([model()])).not.toContain("Codex's tools take");
  // A big model where every tool fits: a figure that changes nothing is noise on a phone.
  const roomy = model({ id: "kimi-k3.1-pro", label: "kimi-k3.1-pro", contextWindow: 1_048_576, toolCost: cost({ model: "kimi-k3.1-pro", window: 1_048_576, dropped: undefined }) });
  expect(picker([roomy])).not.toContain("Codex's tools take");
});

test("a service's row in Settings says it whatever it is, with the model it was measured on", () => {
  const shown = row(account({ toolCost: cost() }));
  expect(shown).toContain("Codex's tools take about 134,000 tokens; qwen3-8b holds 16,384.");
  expect(shown).toContain("Measured today.");
  // Nothing has gone through this one yet: the row says nothing rather than borrowing another service's figure.
  expect(row(account({}))).not.toContain("Codex's tools take");
  // And a service that isn't a model server of your own has none at all.
  expect(row({ ...account(null), kind: "signin", label: "Main", plan: "Plus" })).not.toContain("Codex's tools take");
});
