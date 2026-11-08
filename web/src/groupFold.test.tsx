import { expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { FoldableGroup, type GroupFold } from "./views/GroupFold";

// A folded group of the chat list (GroupFold.tsx), drawn without a browser: what its heading says, what its control is
// named, and that its rows hang off that control. The taps, the keyboard and what survives a reload are in
// web/e2e/chatFold.spec.ts.

const fold = (over: Partial<GroupFold> = {}): GroupFold => ({ folded: false, foldable: true, count: 3, attention: 0, mark: "", onFold: () => {}, ...over });
const draw = (over: Partial<GroupFold> = {}, title = "Claude Code") =>
  renderToStaticMarkup(
    createElement(
      FoldableGroup,
      { title, heading: createElement("button", { className: "csb-agent" }, title), ...fold(over) },
      createElement("div", { className: "csb-chat" }, "Fix login"),
    ),
  );

test("a folded group hides its rows and says what's inside; open, it only says what it folds", () => {
  const open = draw();
  expect(open).toContain('aria-expanded="true"');
  expect(open).toContain('aria-label="Hide Claude Code chats"');
  expect(open).toContain("Fix login");
  // Nothing about the count while it's open: the rows are right there.
  expect(open).not.toContain("3 chats");

  const folded = draw({ folded: true, attention: 1, mark: "needs" });
  expect(folded).toContain('aria-expanded="false"');
  expect(folded).toContain('aria-label="Show Claude Code chats, 3 chats, 1 needs a look"');
  // In plain words on its own line, below the heading (a phone's heading row has no room beside the name); hidden from
  // a reader, which hears the control's name instead.
  expect(folded).toContain("3 chats, 1 needs a look");
  expect(folded).toContain('<p class="csb-fold-said" aria-hidden="true">');
  expect(folded).not.toContain("Fix login");
  // The mark carries the strongest state inside, not the rows' needs-you orange for every state.
  expect(folded).toContain('class="csb-fold-mark needs"');
  expect(draw({ folded: true, attention: 2, mark: "error" })).toContain('class="csb-fold-mark error"');
  // Working, waiting for a limit or an unread reply: a mark with no colour of its own.
  const plain = draw({ folded: true, attention: 2, mark: "" });
  expect(plain).toContain("csb-fold-mark");
  expect(plain).not.toContain("csb-fold-mark needs");
  expect(plain).not.toContain("csb-fold-mark error");
  // Nothing needing a look: the count alone, and no mark.
  expect(draw({ folded: true })).toContain('aria-label="Show Claude Code chats, 3 chats"');
  expect(draw({ folded: true })).not.toContain("csb-fold-mark");
  // The heading keeps its own action either way.
  for (const html of [open, folded]) expect(html).toContain('<button class="csb-agent">Claude Code</button>');
});

test("the control names the group's rows, even folded, and isn't there while a search is on", () => {
  for (const folded of [false, true]) {
    const html = draw({ folded });
    const named = /aria-controls="([^"]+)"/.exec(html);
    expect(named).not.toBeNull();
    // The rows live in the box the control names, which is there even while the group is folded and empty.
    expect(html).toContain(`<div id="${named![1]}" class="csb-group-rows">`);
  }
  // A search on: no control at all, and every match shows wherever it is.
  const none = draw({ foldable: false });
  expect(none).not.toContain("aria-expanded");
  expect(none).toContain("Fix login");
  // A group with no chats folds as well (the agents' are always listed, so that's how an empty one goes away): its
  // control says there's nothing inside, and the group is its heading alone — no "no chats" line to replace the rows.
  const empty = draw({ folded: true, count: 0 });
  expect(empty).toContain('aria-label="Show Claude Code chats, no chats"');
  expect(empty).not.toContain("Fix login");
  expect(empty).not.toContain("csb-fold-said");
  // Its chats back: the same remembered flag still folds them away, and now it says how many.
  expect(draw({ folded: true, count: 1 })).toContain('aria-label="Show Claude Code chats, 1 chat"');
});
