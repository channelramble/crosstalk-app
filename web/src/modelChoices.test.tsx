import { expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { ModelOption } from "@crosstalk/shared";
import { ModelChoices, ModelSelectOptions, usualFocus } from "./views/ModelChoices";

/** The words on screen: tags stripped, entities read. */
const words = (html: string) => html.replace(/<[^>]+>/g, " ").replace(/&#x27;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, "&").replace(/\s+/g, " ").trim();

const model = (id: string, label: string, patch: Partial<ModelOption> = {}): ModelOption => ({ id, label, description: null, efforts: ["low", "high"], defaultEffort: "low", isDefault: false, ...patch });
// As Codex lists them with its hidden ones (model/list includeHidden): the usual list, then those under More models.
const codex = [
  model("gpt-6.1-sol", "GPT-6.1-Sol", { isDefault: true, description: "Latest workhorse model.", contextWindow: 500_000, maxContextWindow: 872_000 }),
  model("gpt-6-astra", "GPT-6-Astra", { description: "Frontier model." }),
  model("gpt-reserve", "GPT-Reserve", { more: true, description: "Fast and affordable agentic coding model.", contextWindow: 272_000, maxContextWindow: 872_000, firstSeen: Date.now() - 1000 }),
  model("codex-auto-review", "Codex Auto Review", { more: true, description: "Automatic approval review model for Codex." }),
];
const claude = [model("opus", "Opus 5.5", { isDefault: true }), model("sonnet", "Sonnet 5.5"), model("haiku", "Haiku 4.5", { efforts: [] })];
const note = "Codex keeps these out of its usual list.";
const render = (props: Partial<Parameters<typeof ModelChoices>[0]> = {}) => renderToStaticMarkup(createElement(ModelChoices, { models: codex, current: "gpt-6.1-sol", note, onChoose: () => {}, ...props }));

test("the model menu opens on the usual models, with More models as a real button that says how many", () => {
  const html = render();
  expect(words(html)).toContain("GPT-6.1-Sol Default Latest workhorse model. · 500k context, up to 872k");
  expect(words(html)).toContain("GPT-6-Astra");
  // The more ones stay out of the first step: a phone screen isn't filled with them.
  expect(html).not.toContain("GPT-Reserve");
  expect(html).not.toContain("Codex Auto Review");
  // Its name says how many (the number on it alone would read "More models2").
  expect(html).toMatch(/<button type="button" class="pop-item pop-more" aria-label="More models \(2\)" aria-expanded="false" aria-controls="[^"]+">/);
  expect(words(html)).toContain("More models 2");
  // The list it opens is the one the button names.
  const controls = /aria-controls="([^"]+)"/.exec(html)![1];
  expect(html).toContain(`id="${controls}" role="group" aria-label="Models"`);
  expect((html.match(/role="menuitemradio"/g) ?? []).length).toBe(2);
  expect(html).toMatch(/aria-checked="true"[^>]*>(?:(?!<button).)*GPT-6\.1-Sol/);
});

test("More models: a way back, what they are, and each with what Codex says of it; never marked New", () => {
  const html = render({ startWithMore: true });
  expect(html).toMatch(/<button type="button" class="pop-back" aria-label="Back to the usual models">/);
  expect(words(html)).toContain("Back More models Codex keeps these out of its usual list.");
  expect(html).toContain("<h3 class=\"pop-more-title\">More models</h3>");
  expect(words(html)).toContain("GPT-Reserve Fast and affordable agentic coding model. · 272k context, up to 872k");
  expect(words(html)).toContain("Codex Auto Review Automatic approval review model for Codex.");
  // First seen a moment ago (the first list that had it), but not news.
  expect(html).not.toContain("pop-badge new");
  // Only the more ones here: the usual ones are a step back.
  expect(html).not.toContain("GPT-6-Astra");
  expect(html).toContain('role="group" aria-label="More models"');
});

test("a chat on one of the more models: it's in the first step, checked, and More models still has it", () => {
  const first = render({ current: "gpt-reserve" });
  expect(words(first)).toContain("GPT-Reserve");
  expect(first).toMatch(/aria-checked="true"[^>]*>(?:(?!<button).)*GPT-Reserve/);
  expect(words(first)).toContain("More models 2");
  const more = render({ current: "gpt-reserve", startWithMore: true });
  expect(more).toMatch(/aria-checked="true"[^>]*>(?:(?!<button).)*GPT-Reserve/);
});

test("focus back on the usual models: More models, else the model in use, else the first; never dropped out of the menu", () => {
  const el = (name: string) => ({ name }) as unknown as HTMLElement;
  const [opener, checked, first] = [el("more models"), el("model in use"), el("first model")];
  // What the usual step's group holds (a menu item is role="menuitemradio", the one in use aria-checked="true", as rendered above).
  const group = (found: Record<string, HTMLElement>) => ({ querySelector: (selector: string) => found[selector] ?? null }) as unknown as ParentNode;
  const both = group({ '[aria-checked="true"]': checked, '[role="menuitemradio"]': first });
  expect(usualFocus(opener, both)).toBe(opener);
  // A newer list without more models took the button away while More models was open (focus was on Back).
  expect(usualFocus(null, both)).toBe(checked);
  expect(usualFocus(null, group({ '[role="menuitemradio"]': first }))).toBe(first);
  expect(usualFocus(null, null)).toBeNull();
});

test("an agent that names nothing more (Claude Code) has no More models, even asked to start there", () => {
  for (const startWithMore of [false, true]) {
    const html = render({ models: claude, current: "opus", note: "Claude Code keeps these out of its usual list.", startWithMore });
    expect(words(html)).toContain("Opus 5.5");
    expect(words(html)).toContain("Haiku 4.5");
    expect(html).not.toContain("More models");
    expect(html).not.toContain("pop-back");
  }
});

test("drop-downs: the usual models, then a More models group; none when the agent names nothing more", () => {
  const select = (models: ModelOption[], props = {}) => renderToStaticMarkup(createElement("select", null, createElement(ModelSelectOptions, { models, ...props })));
  const html = select(codex);
  expect(html).toMatch(/^<select><option value="gpt-6\.1-sol">GPT-6\.1-Sol · 500k<\/option><option value="gpt-6-astra">GPT-6-Astra<\/option><optgroup label="More models"><option value="gpt-reserve">GPT-Reserve · 272k<\/option><option value="codex-auto-review">Codex Auto Review<\/option><\/optgroup><\/select>$/);
  expect(select(claude)).not.toContain("optgroup");
  // The helper agents' list: its names, saving the full model name.
  const helpers = select(codex.slice(1).map((m) => ({ ...m, resolvedModel: `${m.id}-full` })), { value: (m: ModelOption) => m.resolvedModel ?? m.id, text: (m: ModelOption) => m.label });
  expect(helpers).toContain('<option value="gpt-6-astra-full">GPT-6-Astra</option><optgroup label="More models"><option value="gpt-reserve-full">GPT-Reserve</option>');
});
