// Updates from the app (hub/src/selfUpdate.ts): what the buttons do, for whichever machine they're on. The offer and a
// download's progress come with each machine's info (HubInfo.release), so every device sees the same thing.

import { useEffect, useState } from "react";
import type { HubRelease, UpdateInstall, UpdateStatus } from "@crosstalk/shared";
import { api, type Connection } from "./api";
import { hubStore, useStore } from "./store";

/** While a download runs, the machine is asked how far it is this often: a phone's connection may sleep through an event. */
const PROGRESS_MS = 1500;

export const installing = (i: UpdateInstall | null | undefined): i is UpdateInstall => !!i && i.step !== "failed";

/** What a machine just answered goes where its info is kept, so the banner and Settings say the same at once. */
export function noteUpdate(key: string, s: UpdateStatus) {
  const store = hubStore(key);
  const hub = store?.getState().hub;
  if (!store || !hub) return;
  const release: HubRelease = { available: s.available, install: s.install };
  if (JSON.stringify([hub.release ?? null, hub.update ?? null]) === JSON.stringify([release, s.ready])) return;
  store.setState({ hub: { ...hub, release, update: s.ready } });
}

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** Update, for one machine: `start` begins the download (a second tap while one runs starts nothing). */
export function useUpdate(key: string, conn: Connection | null, release: HubRelease | null | undefined) {
  const [starting, setStarting] = useState(false);
  const running = installing(release?.install);
  useEffect(() => {
    if (!running || !conn) return;
    let gone = false;
    const timer = setInterval(() => {
      api<UpdateStatus>("GET", "/api/update", undefined, conn)
        .then((s) => !gone && noteUpdate(key, s))
        .catch(() => {});
    }, PROGRESS_MS);
    return () => {
      gone = true;
      clearInterval(timer);
    };
  }, [running, key, conn]);
  const start = async () => {
    if (starting || running || !conn) return;
    setStarting(true);
    try {
      noteUpdate(key, await api<UpdateStatus>("POST", "/api/update/install", undefined, conn));
    } catch (e) {
      useStore.getState().toast("error", message(e));
    } finally {
      setStarting(false);
    }
  };
  return { start, starting, running };
}

// "Later" on Home's offer: that version isn't offered there again on this device (Settings → Machines still has it).
const laterKey = (machine: string) => `crosstalk.update.later.${machine}`;
export function saidLater(machine: string): string | null {
  try {
    return localStorage.getItem(laterKey(machine));
  } catch {
    return null;
  }
}
export function sayLater(machine: string, version: string) {
  try {
    localStorage.setItem(laterKey(machine), version);
  } catch {
    // Private browsing: it's asked again next time.
  }
}
