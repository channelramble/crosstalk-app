import { expect, test } from "bun:test";
import type { Message } from "@crosstalk/shared";
import { withSent } from "./sent";

const msg = (id: string, seq: number | undefined, at: number, authorKind: Message["authorKind"] = "human"): Message => ({
  id,
  ...(seq === undefined ? {} : { seq }),
  roomId: "r",
  authorKind,
  memberId: null,
  authorName: "Phone",
  text: id,
  mentions: [],
  turnId: null,
  status: "done",
  createdAt: at,
  updatedAt: at,
});

test("adds the message you sent once, at the end", () => {
  const list = [msg("a", 1, 1000), msg("b", 2, 2000)];
  const sent = msg("mine", 3, 3000);
  const once = withSent(list, sent);
  expect(once.map((m) => m.id)).toEqual(["a", "b", "mine"]);
  // Sent again (a second answer, a retry of the request): still once.
  expect(withSent(once, sent).map((m) => m.id)).toEqual(["a", "b", "mine"]);
  expect(list.map((m) => m.id)).toEqual(["a", "b"]); // the list it was given isn't changed
});

test("keeps the live copy when its event came first", () => {
  const live = { ...msg("mine", 3, 3000), text: "as the event had it" };
  const list = [msg("a", 1, 1000), live];
  const same = withSent(list, msg("mine", 3, 3000));
  expect(same).toBe(list);
  expect(same[1].text).toBe("as the event had it");
});

test("keeps the order: a reply that showed up before the answer stays after your message", () => {
  // The hub starts the reply as it saves your message, so its event can beat the answer to sending.
  const reply = { ...msg("reply", 4, 3000, "agent"), status: "streaming" as const };
  const list = [msg("a", 1, 1000), msg("b", 2, 2000), reply];
  expect(withSent(list, msg("mine", 3, 3000)).map((m) => m.id)).toEqual(["a", "b", "mine", "reply"]);
  // From a hub that doesn't say where messages go: by time.
  const old = [msg("a", undefined, 1000), msg("later", undefined, 5000)];
  expect(withSent(old, msg("mine", undefined, 3000)).map((m) => m.id)).toEqual(["a", "mine", "later"]);
});
