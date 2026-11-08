// Pinned chats (POST /api/rooms/:id/pin): kept at the top of every device's chat list, in the order the user set. Each
// chat's pin lives on its own machine's hub, and every device hears of a change through the usual `room` event. The app
// picks the places, on one scale for all of a person's machines (a chat here can sit between two of another machine's),
// so a move writes only to the moved chat's machine. Pinning isn't activity: the chat's updatedAt stays.

import type { Room } from "@crosstalk/shared";
import type { App } from "./app";
import { HttpError } from "./engine/engine";

/** Places beyond this are refused: the app numbers its pins again long before (0, 1, 2…). */
const MAX_PIN_ORDER = 1e12;

/** Never the bare "not found" of a route a hub doesn't have: the app takes that for a hub from before pins. */
const GONE = "That chat is gone. It may have been deleted on another device.";

/**
 * Pins a chat or unpins it. `order` is its place; without one, a new pin goes above this hub's others, and above those
 * pinned earlier on the person's other machines (the app's rule, web chatList.ts newPinOrder: a place at most minus the
 * seconds since 1970), and a pinned chat stays where it is.
 */
export function pinChat(app: App, roomId: string, body: unknown): Room {
  const room = app.store.getRoom(roomId);
  if (!room) throw new HttpError(404, GONE, "no_room");
  const b = (body && typeof body === "object" ? body : {}) as { pinned?: unknown; order?: unknown };
  if (typeof b.pinned !== "boolean") throw new HttpError(400, "Say whether to pin the chat (pinned: true or false).");
  const order = b.order ?? undefined;
  if (order !== undefined && (typeof order !== "number" || !Number.isFinite(order) || Math.abs(order) > MAX_PIN_ORDER)) throw new HttpError(400, "That place in the list isn't one the hub can keep.");
  let pin: { at: number; order: number } | null = null;
  if (room.pinnedAt && b.pinned) {
    // Pinned already: a move. When it was pinned stays, and so does its place unless one is given.
    pin = { at: room.pinnedAt, order: typeof order === "number" ? order : (room.pinOrder ?? 0) };
  } else if (b.pinned) {
    const at = Date.now();
    const top = app.store.topPinOrder();
    pin = { at, order: typeof order === "number" ? order : Math.min(top === null ? Infinity : top - 1, -at / 1000) };
  }
  const next = app.store.setPin(roomId, pin);
  if (!next) throw new HttpError(404, GONE, "no_room");
  app.bus.emit({ t: "room", room: next });
  return next;
}
