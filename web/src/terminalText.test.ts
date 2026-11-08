import { expect, test } from "bun:test";
import { newerThan, oneTimeCode, plainText } from "./terminalText";

test("GitHub's one-time code is found in a sign-in terminal's output, colours and all", () => {
  const out = "\x1b[33m!\x1b[0m First copy your one-time code: \x1b[1m7a3f-9b2c\x1b[0m\r\nPress Enter to open github.com in your browser...";
  expect(oneTimeCode(plainText(out))).toBe("7A3F-9B2C");
  // The newest one, when it asks again.
  expect(oneTimeCode(plainText(`${out}\r\n! First copy your one-time code: 1111-2222`))).toBe("1111-2222");
  expect(oneTimeCode("Paste code here if prompted > ")).toBeNull();
});

test("output that came live while the terminal was read again shows once, in order", () => {
  const whole = "Opening the sign-in page…\r\nPaste code here > ";
  // Both pieces were in what was read: nothing more to show.
  expect(newerThan(whole, ["Paste code ", "here > "])).toEqual([]);
  // The first was in it; the second came after.
  expect(newerThan(whole, ["here > ", "abc"])).toEqual(["abc"]);
  // None of it was in it yet.
  expect(newerThan("Opening the sign-in page…", ["\r\nPaste", " code"])).toEqual(["\r\nPaste", " code"]);
  expect(newerThan(whole, [])).toEqual([]);
});
