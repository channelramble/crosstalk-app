// Ask others: the requests the sheet, the cards and the message box make, and how their answers reach the app's state.

import type { Ask, AskMemo, AskTarget } from "@crosstalk/shared";
import { api } from "./api";
import { upsertAsks } from "./asks";
import { hubStore, machineOfRoom, useStore } from "./store";

/**
 * Changes a chat's asks in its own machine's store (the app's view mirrors it, so a later update there can't drop
 * the change), the way a sent message is added.
 */
export function patchAsks(roomId: string, change: (list: Ask[]) => Ask[]) {
  const key = machineOfRoom(roomId);
  const machine = key !== null ? hubStore(key) : undefined;
  const patch = (s: { asks: Record<string, Ask[]> }) => ({ asks: { ...s.asks, [roomId]: change(s.asks[roomId] ?? []) } });
  if (machine) machine.setState(patch);
  else useStore.setState(patch);
}

/**
 * POST /api/asks: asks each target about a message. The new cards are in the chat at once (the live events may be late).
 * `remember` (the sheet's): the model picks for the hub to keep for next time, once it took the question.
 */
export async function postAsks(input: { roomId: string; messageId: string; targets: AskTarget[]; note?: string | null; remember?: AskMemo[] }): Promise<Ask[]> {
  const asks = await api<Ask[]>("POST", "/api/asks", { ...input, note: input.note || undefined });
  patchAsks(input.roomId, (list) => upsertAsks(list, asks));
  return asks;
}

/** An ask, as the hub has it now (after Stop). */
export function keepAsk(ask: Ask) {
  patchAsks(ask.roomId, (list) => upsertAsks(list, [ask]));
}

/** DELETE /api/asks/:id: the card is gone, here and (by the hub's event) on every device. */
export async function removeAsk(ask: Pick<Ask, "id" | "roomId">) {
  await api("DELETE", `/api/asks/${encodeURIComponent(ask.id)}`);
  patchAsks(ask.roomId, (list) => list.filter((a) => a.id !== ask.id));
}
