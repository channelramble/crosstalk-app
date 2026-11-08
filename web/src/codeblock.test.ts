import { expect, test } from "bun:test";
import { codeBlockView } from "./codeblock";

test("blocks of up to 12 lines open, longer ones preview 8 lines", () => {
  for (const lines of [1, 3, 8, 12]) expect(codeBlockView(lines, null)).toEqual({ whole: true, showAll: false, collapse: false });
  for (const lines of [13, 40, 400]) expect(codeBlockView(lines, null)).toEqual({ whole: false, showAll: true, collapse: false });
});

test("a choice made by tapping wins over the default", () => {
  // Show all: whole, with Collapse at the end, however long it grows while its reply streams.
  for (const lines of [13, 40, 400]) expect(codeBlockView(lines, true)).toEqual({ whole: true, showAll: false, collapse: true });
  // A short block that was opened has nothing to collapse.
  expect(codeBlockView(5, true)).toEqual({ whole: true, showAll: false, collapse: false });
  // Collapse: back to the preview, even once it's no longer than 12 lines.
  expect(codeBlockView(40, false)).toEqual({ whole: false, showAll: true, collapse: false });
  expect(codeBlockView(10, false)).toEqual({ whole: false, showAll: true, collapse: false });
  // A block no longer than the preview always shows whole.
  expect(codeBlockView(8, false)).toEqual({ whole: true, showAll: false, collapse: false });
});
