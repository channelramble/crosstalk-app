import { expect, test } from "bun:test";
import { accountDescription, accountKey, accountQuery } from "./accounts";

test("default and named sign-ins, usage and login flows have distinct keys", () => {
  expect(accountKey("codex", null)).toBe("codex");
  expect(accountKey("codex", "default")).toBe("codex");
  expect(accountKey("codex", "work")).toBe("codex:work");
  expect(accountKey("claude", "work")).not.toBe(accountKey("codex", "work"));
});

test("account routes and labels preserve the chosen identity", () => {
  expect(accountQuery("/api/providers/codex/models", "a&b")).toBe("/api/providers/codex/models?account=a%26b");
  expect(accountQuery("/route?refresh=1", "work")).toBe("/route?refresh=1&account=work");
  expect(accountQuery("/route", null)).toBe("/route");
  expect(accountDescription("Work", "me@example.com")).toBe("Work · me@example.com");
  expect(accountDescription("Work", null)).toBe("Work");
});
