import { expect, test } from "bun:test";
import { privateFileRules } from "../src/agents/claude";

test("Claude Code's file tools are kept out of Crosstalk's private files, and not out of an extra account's own notes", () => {
  const rules = privateFileRules("/Users/someone/.crosstalk");
  for (const file of ["secrets.json", "vapid.json", "config.json", "crosstalk.db*", "run/**", "ssh/**", "computers/**", "backups/**", "accounts/**/.credentials.json", "accounts/**/auth.json"]) {
    expect(rules).toContain(`Read(//Users/someone/.crosstalk/${file})`);
    expect(rules).toContain(`Edit(//Users/someone/.crosstalk/${file})`);
  }
  // An absolute path in a rule starts with two slashes; a trailing slash on the folder changes nothing.
  expect(privateFileRules("/Users/someone/.crosstalk/")).toEqual(rules);
  // Not the whole of accounts/: an extra account's Claude Code keeps its memory there.
  expect(rules.some((r) => /accounts\/\*\*\)$/.test(r))).toBe(false);
});
