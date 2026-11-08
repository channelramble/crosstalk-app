// Opening a chat at a message a search found (docs/SPEC-0.4.md section 14, track T8): the sidebar sets the target
// (openHit), and the chat screen, once it has the message loaded, scrolls to it and flashes it once.

import { useEffect, useRef, type RefObject } from "react";
import { loadUntil, useFind, type Find } from "../findMessage";
import type { FoundHit } from "../search";
import { isDrawn } from "../scrollPlace";
import { useStore } from "../store";

/** A target is forgotten after this long (the person went somewhere else before it was found). */
const FRESH_MS = 60_000;

/** Opens the chat a hit is in, on its machine, at that message. */
export function openHit(h: Pick<FoundHit, "machineKey" | "roomId" | "messageId" | "query">) {
  const app = useStore.getState();
  const target: Find = { roomId: h.roomId, messageId: h.messageId, query: h.query, at: Date.now() };
  useFind.getState().set(target);
  if (app.active !== h.machineKey) app.activate(h.machineKey);
  app.openRoom(h.roomId);
  // Refused (a message with files waiting to be sent, and the person chose to stay): nothing to find then.
  const now = useStore.getState();
  if (now.view !== "room" || now.roomId !== h.roomId) useFind.getState().clear(target);
}

/** The first place `query` shows in the message's own text, as the element holding it (null: not as plain text). */
function matchIn(msg: HTMLElement, query: string): HTMLElement | null {
  const q = query.toLowerCase();
  const walker = document.createTreeWalker(msg.querySelector(".bubble") ?? msg, NodeFilter.SHOW_TEXT);
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    const el = n.parentElement;
    if (el && n.nodeValue!.toLowerCase().includes(q) && isDrawn(el)) return el;
  }
  return null;
}

const frame = () => new Promise<void>((done) => requestAnimationFrame(() => done()));

/**
 * Scrolls the chat to a message once it's drawn: to where the query shows in it (a long reply isn't opened at its top),
 * in the middle of the screen when that part fits. Then the message flashes once (CSS `[data-found]`).
 */
async function reveal(scroller: HTMLElement, f: Find, alive: () => boolean): Promise<void> {
  for (let tries = 0; tries < 30 && alive(); tries++) {
    await frame();
    const msg = scroller.querySelector<HTMLElement>(`[data-mid="${CSS.escape(f.messageId)}"]`);
    if (!msg || !isDrawn(msg)) continue;
    const spot = matchIn(msg, f.query) ?? msg;
    spot.scrollIntoView({ block: spot.getBoundingClientRect().height < scroller.getBoundingClientRect().height * 0.7 ? "center" : "start" });
    msg.setAttribute("data-found", "");
    setTimeout(() => msg.removeAttribute("data-found"), 2200);
    return;
  }
}

/**
 * The chat on screen, opened by a search hit: loads history back to the message, then scrolls to it. `stopFollowing`:
 * the chat stops following the newest message (it would scroll back down). A message that's gone, or earlier history
 * that wouldn't load, is said, and the chat stays at its newest message.
 */
export function useFindMessage(roomId: string, scroller: RefObject<HTMLElement | null>, stopFollowing: () => void) {
  const find = useFind((s) => (s.find?.roomId === roomId ? s.find : null));
  const stop = useRef(stopFollowing);
  stop.current = stopFollowing;
  useEffect(() => {
    if (!find) return;
    if (Date.now() - find.at > FRESH_MS) return useFind.getState().clear(find);
    let alive = true;
    void (async () => {
      const result = await loadUntil(roomId, find.messageId, useStore);
      if (!alive) return;
      if (result === "found") {
        stop.current();
        if (scroller.current) await reveal(scroller.current, find, () => alive);
      } else if (result === "gone") {
        useStore.getState().toast("info", "That message isn't in this chat any more: it was edited or taken back. The chat is open at its newest message.");
      } else {
        useStore.getState().toast("error", "Couldn't get back to that message. The chat is open at its newest message.", { action: { label: "Try again", run: () => useFind.getState().set({ ...find, at: Date.now() }) } });
      }
      useFind.getState().clear(find);
    })();
    return () => {
      alive = false;
    };
  }, [find, roomId, scroller]);
}
