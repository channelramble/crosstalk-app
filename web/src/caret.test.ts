import { expect, test } from "bun:test";
import { caretPlan, withMention, withQuote, type CaretWish } from "./caret";

/** A stand-in message box holding `value`, in a document where `live` elements are still on the page. */
function box(value: string, live: Element[] = []) {
  const body = {} as Element;
  const el: Record<string, unknown> = { value };
  el.ownerDocument = { body, contains: (n: Element) => live.includes(n) };
  return { el: el as unknown as HTMLTextAreaElement, body };
}

const el = (name: string) => ({ name }) as unknown as Element;

test("picking a name fills the box and puts the caret after it, keeping what came after the caret", () => {
  expect(withMention("@", 0, 1, "second")).toMatchObject({ text: "@second ", pos: 8 });
  expect(withMention("Hi @se", 3, 6, "second")).toMatchObject({ text: "Hi @second ", pos: 11 });
  // A name picked in the middle: what follows the half-typed name stays where it was.
  expect(withMention("Hi @se, look", 3, 6, "second")).toMatchObject({ text: "Hi @second , look", pos: 11 });
  expect(withMention("@f", 0, 2, "all")).toMatchObject({ text: "@all ", pos: 5 });
});

test("a quoted answer leaves the caret at the end, to write under it", () => {
  expect(withQuote("> an answer\n\n")).toMatchObject({ text: "> an answer\n\n", pos: 13 });
});

test("the caret goes after the picked name, and the box takes focus back", () => {
  const { el: ta } = box("@second ");
  const option = el("option"); // the popup option that was clicked, gone from the page by now
  expect(caretPlan(withMention("@", 0, 1, "second", option)!, ta, option)).toEqual({ pos: 8, focus: true });
});

test("typed since the pick: the caret is left where the typing put it", () => {
  const { el: ta } = box("@second Say ");
  const wish: CaretWish = withMention("@", 0, 1, "second", null)!;
  expect(caretPlan(wish, ta, ta as unknown as Element)).toBeNull();
});

test("focus moved to something else since the pick: the caret is set, the focus isn't stolen", () => {
  const search = el("search");
  const { el: ta } = box("@second ", [search]);
  expect(caretPlan(withMention("@", 0, 1, "second", null)!, ta, search)).toEqual({ pos: 8, focus: false });
});

test("nothing in particular holds focus: the box takes it", () => {
  const { el: ta, body } = box("@second ");
  expect(caretPlan(withMention("@", 0, 1, "second", null)!, ta, body)).toEqual({ pos: 8, focus: true });
  expect(caretPlan(withMention("@", 0, 1, "second", null)!, ta, null)).toEqual({ pos: 8, focus: true });
  // The answer card's own "Send to the chat" button still holds focus: that click asked for the box.
  const button = el("send-to-chat");
  const { el: quoted } = box("> an answer\n\n", [button]);
  expect(caretPlan(withQuote("> an answer\n\n", button), quoted, button)).toEqual({ pos: 13, focus: true });
});

test("a pick after the caret left the half-typed name does nothing: the draft is never duplicated", () => {
  // Nothing closes the popup when the caret moves, so the pick can name a stretch the person has left.
  expect(withMention("Hi @se", 3, 0, "second")).toBeNull(); // caret moved to the start
  expect(withMention("Hi @se there", 3, 12, "second")).toBeNull(); // caret moved past a space
  expect(withMention("Hi there", 3, 6, "second")).toBeNull(); // no "@" where the popup says
});
