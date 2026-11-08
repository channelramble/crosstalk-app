import { expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { HelpTip } from "./views/HelpTip";

test("a help tip starts closed, with a button that says what it is", () => {
  const html = renderToStaticMarkup(createElement(HelpTip, { label: "What's an API key?" }, "A password for a service."));
  expect(html).toContain('aria-expanded="false"');
  expect(html).toContain("?");
  expect(html).not.toContain('role="note"');
  expect(html).not.toContain("A password for a service.");
});
