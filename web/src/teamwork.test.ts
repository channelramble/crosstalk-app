import { expect, test } from "bun:test";
import type { Member, Room } from "@crosstalk/shared";
import { messageRecipients, recipientPreview } from "./teamwork";

const members = [{ id: "b", handle: "builder" }, { id: "r", handle: "Reviewer" }] as Member[];
const room = { mode: "direct", leadMemberId: "r" } as Room;

test("recipient preview matches aliases, case-insensitive handles and ignored code mentions", () => {
  for (const text of ["@all help", "@EVERYONE help"]) expect(messageRecipients(text, members)).toEqual(members);
  expect(recipientPreview(room, members, "@REVIEWER help")).toBe("@Reviewer");
  expect(recipientPreview(room, members, "@builder and @BUILDER")).toBe("@builder");
  expect(recipientPreview(room, members, "Check `@builder` and @unknown")).toBe("@Reviewer");
  expect(recipientPreview(room, [], "@all help")).toBeNull();
});
