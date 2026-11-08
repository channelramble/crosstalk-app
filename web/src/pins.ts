// Pinning chats (hub pins.ts): each chat's pin and place are kept by its own machine's hub, which tells every device
// with a `room` event. The places are on one scale for every machine, worked out here (chatList.ts): a move writes only
// to the moved chat's machine, unless no number fits between its new neighbours (then the pins are numbered again).

import type { Room } from "@crosstalk/shared";
import { api } from "./api";
import { movedPins, newPinOrder, pinOrderAt, pinProblem, renumberPins } from "./chatList";
import { hubStore, useStore, type Machine } from "./store";

// For the screens that pin (Chat settings).
export { isPinned } from "./chatList";

/** A chat in the list, with its machine. */
export interface PinRow {
  room: Room;
  machine: Machine;
}

/** A pin that didn't happen, in words (see pinProblem), with its machine. */
export class PinError extends Error {
  constructor(
    message: string,
    public machine: Machine,
    public why: "older" | "down" | "other",
  ) {
    super(message);
  }
}

/**
 * Pins a chat on its machine (at `order`, on the scale of every machine's pins) or unpins it. Shown here at once; other
 * devices hear it from the hub. Throws a PinError.
 */
export async function setPin(machine: Machine, roomId: string, pin: { pinned: boolean; order?: number }): Promise<Room> {
  const store = hubStore(machine.key);
  const before = store?.getState().rooms[roomId];
  let room: Room;
  try {
    room = await api<Room>("POST", `/api/rooms/${encodeURIComponent(roomId)}/pin`, pin, machine.conn);
  } catch (e) {
    const p = pinProblem(e, machine.name);
    throw new PinError(p.text, machine, p.why);
  }
  // Only its pin is taken from the answer, and only if nothing replaced the chat here meanwhile: an answer can arrive
  // after the pin's own `room` event, and after another device's change too (a pin here then an unpin there leaves the
  // pin it had, so comparing pins can't tell). The hub sends that event for every pin: skipping the answer loses nothing.
  store?.setState((s) => {
    const cur = s.rooms[roomId];
    if (!cur || cur !== before) return s;
    const { pinnedAt: _at, pinOrder: _order, ...rest } = cur;
    return { rooms: { ...s.rooms, [roomId]: room.pinnedAt ? { ...rest, pinnedAt: room.pinnedAt, pinOrder: room.pinOrder ?? 0 } : rest } };
  });
  return room;
}

/** Pins a chat above every pinned chat of `machines` (all of them), or unpins it. */
export function pinChat(machine: Machine, roomId: string, pinned: boolean, machines: Machine[]): Promise<Room> {
  if (!pinned) return setPin(machine, roomId, { pinned: false });
  return setPin(machine, roomId, { pinned: true, order: newPinOrder(machines.flatMap((m) => Object.values(m.rooms).filter((r) => r.chat))) });
}

/**
 * Moves the pinned row at `from` to `to` (in the pinned list, every machine's): one request to its machine, or, when no
 * number fits between its new neighbours, one for each pinned chat whose place changes as they're numbered 0, 1, 2…
 */
export async function movePin(rows: PinRow[], from: number, to: number): Promise<void> {
  const row = rows[from];
  if (!row || from === to) return;
  const order = pinOrderAt(rows.map((r) => r.room), from, to);
  if (order !== null) {
    await setPin(row.machine, row.room.id, { pinned: true, order });
    return;
  }
  const changes = renumberPins(movedPins(rows, from, to), (r) => r.room.pinOrder);
  const done = await Promise.allSettled(changes.map((c) => setPin(c.row.machine, c.row.room.id, { pinned: true, order: c.order })));
  const failed = done.find((d): d is PromiseRejectedResult => d.status === "rejected");
  if (failed) throw failed.reason;
}

/** Says why a pin didn't happen: a machine that can't be reached gets Try now. */
export function pinFailed(e: unknown) {
  const app = useStore.getState();
  if (e instanceof PinError && e.why === "down") app.toast("error", e.message, { action: { label: "Try now", run: () => useStore.getState().reconnectNow(e.machine.key) } });
  else if (e instanceof PinError && e.why === "older") app.toast("warn", e.message);
  else app.toast("error", e instanceof Error ? e.message : String(e));
}
