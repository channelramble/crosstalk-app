/** The machines (hubs) this device is paired with, kept in this browser. */

import { loadConnection, normalizeBaseUrl, type Connection } from "./api";

const KEY = "crosstalk.machines.v1";
const OLD_KEY = "crosstalk.conn.v1";

export interface SavedMachines {
  list: Connection[];
  /** The machine whose screens are showing (see machineKey). */
  active: string;
}

/** A machine's key: its hub's address, or "" for the hub this page was opened from. */
export function machineKey(c: Pick<Connection, "baseUrl">): string {
  const base = normalizeBaseUrl(c.baseUrl ?? "");
  return typeof location !== "undefined" && base === location.origin ? "" : base;
}

export function loadMachines(): SavedMachines {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) {
      const m = JSON.parse(raw) as SavedMachines;
      const list = (Array.isArray(m.list) ? m.list : []).filter((c) => c && typeof c.token === "string" && c.token);
      return { list, active: typeof m.active === "string" ? m.active : "" };
    }
  } catch {
    // unreadable: start from the old single connection below
  }
  // Before several machines: one connection.
  const one = loadConnection();
  return { list: one ? [one] : [], active: one ? machineKey(one) : "" };
}

export function saveMachines(m: SavedMachines) {
  try {
    localStorage.setItem(KEY, JSON.stringify(m));
    // Keep the old single connection (the first machine) for an older app version opened on this device.
    const first = m.list.find((c) => machineKey(c) === "") ?? m.list[0];
    if (first) localStorage.setItem(OLD_KEY, JSON.stringify(first));
    else localStorage.removeItem(OLD_KEY);
  } catch {
    // storage unavailable (private mode): pairing just won't persist
  }
}
