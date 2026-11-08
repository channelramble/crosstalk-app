import { expect, test } from "bun:test";
import { mergeTextDelta } from "./stream";

test("streaming text joins at its offset without duplicating a snapshot overlap", () => {
  expect(mergeTextDelta("Hi", { offset: 2, delta: " there" })).toBe("Hi there");
  expect(mergeTextDelta("Hi there", { offset: 2, delta: " there" })).toBe("Hi there");
  expect(mergeTextDelta("Hi th", { offset: 2, delta: " there" })).toBe("Hi there");
  expect(mergeTextDelta("🚀", { offset: 2, delta: " ready" })).toBe("🚀 ready");
  expect(mergeTextDelta("Hi", { offset: 5, delta: "lost gap" })).toBeNull();
  expect(mergeTextDelta("changed", { offset: 0, delta: "old" })).toBeNull();
});
