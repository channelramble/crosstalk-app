// Muse Code's sign-in check (hub/src/providers/muse.ts): what each of Muse's own answers means. Once, Muse
// Code 1.4.14 read as "its sign-in couldn't be checked" because only `usage/read` was asked, and that answers `{}`
// until Muse has seen a plan reply — signed in or not. `account/read` says it plainly, so it is asked first.
// Nothing here runs Muse: each test stands in for its answers.
import { expect, test } from "bun:test";
import { museAuth, museSignIn } from "../src/providers/muse";

/** Muse's answers, by method: a function to throw the way an unserved method does. */
const answers = (map: Record<string, unknown | (() => never)>) => {
  const asked: string[] = [];
  const ask = async (method: string) => {
    asked.push(method);
    const v = map[method];
    if (typeof v === "function") (v as () => never)();
    if (v === undefined) throw new Error("method not found");
    return v as Record<string, unknown>;
  };
  return { ask, asked: () => asked };
};

/** A usage payload as `usage/read` gives one once Muse has seen a plan reply. */
const USAGE = { usage: { observedAtMs: 1, tier: "pro", window: { windowDurationMins: 300, usedPercent: 12, resetsAtMs: 2 }, weekly: { usedPercent: 3, resetsAtMs: 4 } } };

test("signed out is signed out, not unknown: a fault seen on a Mac", async () => {
  // Exactly what Muse Code 1.4.14 answers there: loggedOut, and an empty usage.
  const m = answers({ "account/read": { state: "loggedOut", credentialRequired: true }, "usage/read": {} });
  expect(await museAuth(m.ask)).toEqual({ error: null, signedIn: false, account: null, plan: null, authMethod: null });
  expect(m.asked()).toEqual(["account/read", "usage/read"]);
});

test("each credential Muse can be using reads as signed in, with its own words", async () => {
  const meta = answers({ "account/read": { state: "accountLogin", label: "person@example.com" }, "usage/read": USAGE });
  expect(await museAuth(meta.ask)).toEqual({ error: null, signedIn: true, authMethod: "Meta sign-in", account: "person@example.com", plan: "Muse Pro" });
  const stored = answers({ "account/read": { state: "apiKey" }, "usage/read": {} });
  expect(await museAuth(stored.ask)).toEqual({ error: null, signedIn: true, authMethod: "API key", account: null, plan: null });
  const fromEnv = answers({ "account/read": { state: "envKey" }, "usage/read": {} });
  expect(await museAuth(fromEnv.ask)).toEqual({ error: null, signedIn: true, authMethod: "API key", account: null, plan: "Meta API (usage-billed)" });
});

test("a Muse that needs no credential at all is never asked to sign in", async () => {
  const keyless = answers({ "account/read": { state: "loggedOut", credentialRequired: false }, "usage/read": {} });
  expect(await museAuth(keyless.ask)).toMatchObject({ signedIn: true, authMethod: "No sign-in needed" });
});

test("a Muse with no account method falls back to its usage, which proves a sign-in but never the opposite", async () => {
  // `account/read` arrived with Muse 1.4.14 (MSP's experimental surface); an older build has none.
  const older = answers({ "usage/read": USAGE });
  expect(await museAuth(older.ask)).toEqual({ signedIn: true, authMethod: "Meta sign-in", plan: "Muse Pro", error: null });
  const silent = answers({ "usage/read": {} });
  expect(await museAuth(silent.ask)).toEqual({ signedIn: null, error: "this Muse build doesn't say whether it's signed in" });
  // A credential lane named in some newer way: the usage answer decides, rather than reading as signed out.
  const newer = answers({ "account/read": { state: "somethingNew" }, "usage/read": USAGE });
  expect(await museAuth(newer.ask)).toMatchObject({ signedIn: true, plan: "Muse Pro" });
  const newerSilent = answers({ "account/read": { state: "somethingNew" }, "usage/read": {} });
  expect(await museAuth(newerSilent.ask)).toMatchObject({ signedIn: null });
});

test("one question failing never fails the other, and a broken answer is no answer", async () => {
  const noUsage = answers({ "account/read": { state: "accountLogin", label: "person@example.com" } });
  expect(await museAuth(noUsage.ask)).toMatchObject({ signedIn: true, account: "person@example.com", plan: null });
  for (const account of [null, undefined, "loggedOut", [{ state: "loggedOut" }], { state: 7 }, {}]) {
    expect([account, museSignIn(account, null)]).toEqual([account, null]);
  }
  // A display label is only ever a label: long ones are cut, and nothing else is taken from the answer.
  expect(museSignIn({ state: "accountLogin", label: "x".repeat(300), avatarUrl: "https://example.com/a.png" }, null)).toEqual({ signedIn: true, authMethod: "Meta sign-in", account: "x".repeat(120), plan: null });
});
