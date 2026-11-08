// The Name box of a chat's settings (ChatScreen.tsx) and of a group chat's (GroupSettings.tsx): what it may send, and
// what it has to say when it's left empty.

/** What the Name box holds, judged against the name it opened with and the chat's name right now. */
export interface NameEdit {
  /** Typed here since the dialog opened: only then is there a name of this device's to save. */
  changed: boolean;
  /** The name to send (null: nothing to send — nothing was typed here, or the chat is already called that). */
  send: string | null;
  /** What's wrong with the box, in plain words that say what to do (null: nothing is). */
  problem: string | null;
}

/**
 * `typed` is what's in the box, `atOpen` the name the dialog opened with, `live` the chat's name now.
 *
 * Another device can rename the chat while this dialog is open, and that rename stays: a change is only one typed
 * here, measured from what the box opened with, exactly as the Pinned switch beside it works. An empty box is no name
 * at all — a chat needs one, so it's nothing to save and the dialog says so instead of quietly saving nothing.
 */
export function nameEdit(typed: string, atOpen: string, live: string): NameEdit {
  const name = typed.trim();
  if (!name) return { changed: false, send: null, problem: "A chat needs a name. Type one, or press Cancel to leave it as it was." };
  if (name === atOpen) return { changed: false, send: null, problem: null };
  return { changed: true, send: name === live ? null : name, problem: null };
}
