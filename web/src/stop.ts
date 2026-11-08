import { create } from "zustand";
import { api } from "./api";

/**
 * Chats whose Stop was tapped and hasn't finished: the hub can take a few seconds to stop an agent, and Stop, the
 * status line and the rewind dialog all say "Stopping…" meanwhile.
 */
export const useStopping = create<{ rooms: Record<string, true> }>(() => ({ rooms: {} }));

function mark(roomId: string, on: boolean) {
  useStopping.setState((s) => {
    const rooms = { ...s.rooms };
    if (on) rooms[roomId] = true;
    else delete rooms[roomId];
    return { rooms };
  });
}

/**
 * Stops a chat's agent (the active machine's chat). `keepWaiting`: "Stop and answer my message", so what you sent
 * meanwhile is answered next. Resolves false when the hub couldn't be asked.
 */
export async function stopChat(roomId: string, opts: { keepWaiting?: boolean } = {}): Promise<boolean> {
  if (useStopping.getState().rooms[roomId]) return true;
  mark(roomId, true);
  try {
    await api("POST", `/api/rooms/${roomId}/stop`, opts.keepWaiting ? { keepWaiting: true } : {});
    return true;
  } catch {
    return false;
  } finally {
    mark(roomId, false);
  }
}

/** "Couldn't stop. Try again." when a Stop didn't reach the hub. */
export const STOP_FAILED = "Couldn't stop. Try again.";
