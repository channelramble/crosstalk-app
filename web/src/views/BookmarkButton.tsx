// Bookmark, under a message with its other actions (Copy, Ask others): keeps the message on the Bookmarks screen, or
// takes it off. Shown only by a hub that has bookmarks.

import { useState } from "react";
import { Bookmark, BookmarkCheck } from "lucide-react";
import { saveBookmark, withBookmark } from "../bookmarks";
import { hubStore, useStore } from "../store";

export function BookmarkButton({ messageId }: { messageId: string }) {
  const known = useStore((s) => s.bookmarked !== null);
  const on = useStore((s) => !!s.bookmarked?.[messageId]);
  const [saving, setSaving] = useState(false);
  if (!known) return null;
  const toggle = async () => {
    if (saving) return;
    setSaving(true);
    const key = useStore.getState().active;
    try {
      const r = await saveBookmark(messageId, !on);
      // At once, not when the hub's event comes in.
      hubStore(key)?.setState((s) => ({ bookmarked: withBookmark(s.bookmarked, messageId, r.at) }));
    } catch (e) {
      useStore.getState().toast("error", e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  };
  return (
    <button className={`link-action ${on ? "on" : ""}`} disabled={saving} onClick={toggle} aria-pressed={on} title={on ? "Take it out of Bookmarks" : "Keep it in Bookmarks"}>
      {on ? <BookmarkCheck size={12} /> : <Bookmark size={12} />} {on ? "Bookmarked" : "Bookmark"}
    </button>
  );
}
