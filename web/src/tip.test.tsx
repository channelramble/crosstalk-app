import { expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { HELP, type HelpTopic } from "./helpCopy";
import { Tip, TipHeading } from "./views/Tip";

const escaped = (s: string) => s.replaceAll("'", "&#x27;");

test("every topic makes a closed tip whose button says what it asks", () => {
  for (const topic of Object.keys(HELP) as HelpTopic[]) {
    const html = renderToStaticMarkup(createElement(Tip, { topic }));
    expect(html, topic).toContain('aria-expanded="false"');
    expect(html, topic).toContain(`aria-label="${escaped(HELP[topic].label)}"`);
    expect(html, topic).not.toContain('role="note"');
    expect(html, topic).not.toContain(escaped(HELP[topic].text));
  }
});

test("a heading with a tip holds only its own words; the id Settings scrolls to is on the line around it", () => {
  const html = renderToStaticMarkup(createElement(TipHeading, { id: "storage", topic: "storage" }, "Storage"));
  expect(html.startsWith('<div class="tip-line tip-heading" id="storage"><h2 class="settings-heading">Storage</h2>')).toBe(true);
  expect(html).toContain(`aria-label="${escaped(HELP.storage.label)}"`);
  // Without an id there is none (most headings aren't jumped to).
  expect(renderToStaticMarkup(createElement(TipHeading, { topic: "teamwork" }, "Teamwork"))).not.toContain(" id=");
});
