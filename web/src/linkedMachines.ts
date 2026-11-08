// The machines the home hub links (GET /api/machines), as Settings → Machines and the chat list's "<name> was linked ·
// Add it here" both show them. One copy for both: what Settings learns (an unlink, a link, a machine linked on another
// device) is in the chat list at once, instead of the chat list going on offering a machine that is gone for as long as
// it kept its own answer (five minutes on a phone, until a reload where the list is docked).
import { useEffect, useState } from "react";
import type { MachineInfo } from "@crosstalk/shared";
import { api } from "./api";
import type { Machine } from "./store";

/** The chat list asks the home hub at most this often (Settings asks whenever it opens or changes something). */
export const LINKED_KEPT_MS = 5 * 60_000;

let kept: { key: string; at: number; list: MachineInfo[] } | null = null;
const listeners = new Set<(key: string, list: MachineInfo[]) => void>();

/** The last answer from machine `key`, if it's no older than `maxAgeMs` (null: ask). */
export function keptLinked(key: string, maxAgeMs = LINKED_KEPT_MS): MachineInfo[] | null {
  return kept && kept.key === key && Date.now() - kept.at < maxAgeMs ? kept.list : null;
}

/** An answer from machine `key`, from whichever screen asked: every screen showing the list takes it. */
export function noteLinked(key: string, list: MachineInfo[]) {
  kept = { key, at: Date.now(), list };
  for (const fn of listeners) fn(key, list);
}

/** `fn` gets every answer noted from now on; returns the way to stop. */
export function onLinked(fn: (key: string, list: MachineInfo[]) => void): () => void {
  listeners.add(fn);
  return () => void listeners.delete(fn);
}

/** The machines the home hub has links to, kept current by anything Settings → Machines learns. */
export function useLinked(home: Machine | undefined): MachineInfo[] {
  const key = home?.key ?? null;
  const [list, setList] = useState<MachineInfo[]>(() => (key === null ? null : keptLinked(key, Infinity)) ?? []);
  const open = home?.status === "open";
  useEffect(() => {
    if (key === null) return;
    return onLinked((k, l) => {
      if (k === key) setList(l);
    });
  }, [key]);
  useEffect(() => {
    if (!home || !open) return;
    const fresh = keptLinked(home.key);
    if (fresh) {
      setList(fresh);
      return;
    }
    // An older hub has no list: nothing to offer.
    api<MachineInfo[]>("GET", "/api/machines", undefined, home.conn).then(
      (l) => noteLinked(home.key, Array.isArray(l) ? l : []),
      () => noteLinked(home.key, []),
    );
  }, [key, open]); // eslint-disable-line react-hooks/exhaustive-deps
  return list;
}
