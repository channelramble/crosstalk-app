import { expect, test } from "bun:test";
import { nameEdit } from "./chatName";

// The Name box of Chat settings and of a group chat's settings. The dialogs themselves are checked in
// web/e2e/polish-chats.spec.ts ("never undoes a rename made on another device", "can't be emptied by accident").

test("nothing typed is nothing to save, whatever another device has renamed the chat to meanwhile", () => {
  // The box still holds the name it opened with: there's nothing of this device's to save, so Save stays off and the
  // rename made elsewhere is never written back over.
  expect(nameEdit("Fix login", "Fix login", "Fix login")).toEqual({ changed: false, send: null, problem: null });
  expect(nameEdit("Fix login", "Fix login", "Payments API")).toEqual({ changed: false, send: null, problem: null });
  // Spaces around it are not a change either.
  expect(nameEdit("  Fix login  ", "Fix login", "Payments API")).toEqual({ changed: false, send: null, problem: null });
});

test("a name typed here is saved, and not sent again when the chat is already called that", () => {
  expect(nameEdit("Payments API", "Fix login", "Fix login")).toEqual({ changed: true, send: "Payments API", problem: null });
  expect(nameEdit(" Payments API ", "Fix login", "Fix login")).toEqual({ changed: true, send: "Payments API", problem: null });
  // Typed here, and another device got there first with the same name: still a change of this device's, nothing to send.
  expect(nameEdit("Payments API", "Fix login", "Payments API")).toEqual({ changed: true, send: null, problem: null });
});

test("an empty box says what to do, and is nothing to save", () => {
  for (const typed of ["", "   ", "\t"]) {
    const said = nameEdit(typed, "Fix login", "Fix login");
    expect(said.changed).toBe(false);
    expect(said.send).toBeNull();
    // Says what's wrong and what to do, rather than leaving Save on to close the dialog having changed nothing.
    expect(said.problem).toBe("A chat needs a name. Type one, or press Cancel to leave it as it was.");
  }
});
