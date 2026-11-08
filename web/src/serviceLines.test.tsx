import { expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { ServiceTestResult } from "@crosstalk/shared";
import { serviceOutcome } from "./services";
import { ServiceLines } from "./views/ServiceLines";

const result = (over: Partial<ServiceTestResult>): ServiceTestResult => ({ reachable: true, authOk: true, server: null, protocols: { responses: "no", messages: "no", chat: "yes" }, models: [{ id: "m", contextWindow: null }], works: [], problems: [], ...over });
const draw = (r: ServiceTestResult) => renderToStaticMarkup(createElement(ServiceLines, { outcome: serviceOutcome(r) }));

test("before a check there's an empty live region waiting, so what it finds is read out", () => {
  // A live region that appears together with its first words isn't announced: this one is on the screen from the start
  // (web/src/views/AiServices.tsx and AddServiceSheet.tsx mount it whether a check has run or not).
  expect(renderToStaticMarkup(createElement(ServiceLines, { outcome: null }))).toBe('<div class="svc-result" aria-live="polite"></div>');
});

test("a good check is a list of ticks, read out when it changes", () => {
  const html = draw(result({ works: [{ provider: "codex", via: "responses" }] }));
  expect(html).toContain('aria-live="polite"');
  expect(html.match(/class="ok"/g)).toHaveLength(4);
  expect(html).not.toContain('class="bad"');
  for (const line of ["Reachable", "Key works", "1 model found", "Works with Codex"]) expect(html).toContain(line);
  // A service Codex reaches directly has no adapter to explain.
  expect(html).not.toContain("chat adapter");
});

test("the adapter's line carries its own ?, closed until tapped", () => {
  const html = draw(result({ works: [{ provider: "codex", via: "adapter" }] }));
  expect(html).toContain("through the chat adapter");
  expect(html).toContain("What&#x27;s the chat adapter?");
  expect(html).toContain('aria-expanded="false"');
  expect(html).not.toContain("translates for them");
});

test("a refused key shows its cross and the problem with its fix, and nothing about a service the hub never reached", () => {
  const html = draw(result({ authOk: false, models: [], problems: ["This key was refused. Check it at console.mistral.ai."] }));
  expect(html).toContain("Key refused");
  // Reachable is the one tick; the refusal is the one cross.
  expect(html.match(/class="ok"/g)).toHaveLength(1);
  expect(html.match(/class="bad"/g)).toHaveLength(1);
  expect(html).toContain("This key was refused. Check it at console.mistral.ai.");
  expect(html).not.toContain("Works with");
  // The fix is the key: the service isn't judged ("No models listed", "Not usable with Claude Code or Codex yet").
  expect(html).not.toContain("No models listed");
  expect(html).not.toContain("Not usable");
});

test("a service that answers but nothing can run on still says so", () => {
  const html = draw(result({ models: [], works: [], problems: ["It speaks none of the styles Claude Code or Codex use."] }));
  for (const line of ["Reachable", "Key works", "No models listed", "Not usable with Claude Code or Codex yet"]) expect(html).toContain(line);
});
