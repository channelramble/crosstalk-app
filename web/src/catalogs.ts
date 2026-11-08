import { create } from "zustand";
import type { ModelCatalog, Provider } from "@crosstalk/shared";
import { api, type Connection } from "./api";
import { accountQuery } from "./accounts";
import { machineKey } from "./machines";

/**
 * Each machine's model lists (one per agent and account), as its hub last said. Every screen reads them from here, so
 * they all show the same list, and a "models" event from the hub (a model came or went, a context size changed)
 * updates them all without reopening anything.
 */
interface Entry {
  catalog: ModelCatalog | null;
  /** The last request failed (the list shown, if any, is an older one). */
  failed: boolean;
  at: number;
}

export const useCatalogs = create<{ entries: Record<string, Entry> }>(() => ({ entries: {} }));

/** How long a list is used before it's asked for again; the hub tells of changes meanwhile. */
const FRESH_MS = 10 * 60_000;

export const catalogKey = (machine: string, provider: string, account: string | null | undefined) => `${machine}|${provider}|${account || "default"}`;

const loading = new Map<string, Promise<void>>();

function store(key: string, entry: Entry) {
  useCatalogs.setState((s) => ({ entries: { ...s.entries, [key]: entry } }));
}

/** Asks the hub for an agent's model list, unless a fresh one is here already (or `force`). */
export function loadCatalog(conn: Connection, provider: Provider, account: string | null | undefined, force = false): Promise<void> {
  const machine = machineKey(conn);
  const key = catalogKey(machine, provider, account);
  const cur = useCatalogs.getState().entries[key];
  // A list of suggestions (the agent couldn't be asked: not installed or signed in yet) is asked for again each time.
  if (!force && cur && !cur.failed && cur.catalog?.live !== false && Date.now() - cur.at < FRESH_MS) return Promise.resolve();
  const running = loading.get(key);
  if (running) return running;
  const job = api<ModelCatalog>("GET", accountQuery(`/api/providers/${provider}/models`, account || "default"), undefined, conn)
    // Tagged with the account it was asked for, which is what the screens compare against.
    .then((c) => store(key, { catalog: { ...c, provider, accountId: account || "default" }, failed: false, at: Date.now() }))
    .catch(() => store(key, { catalog: useCatalogs.getState().entries[key]?.catalog ?? null, failed: true, at: Date.now() }))
    .finally(() => loading.delete(key));
  loading.set(key, job);
  return job;
}

/** The hub says an agent's list changed. */
export function putCatalog(conn: Connection, catalog: ModelCatalog) {
  store(catalogKey(machineKey(conn), catalog.provider, catalog.accountId), { catalog: { ...catalog, accountId: catalog.accountId || "default" }, failed: false, at: Date.now() });
}

/** A machine reconnected: what it said may have changed while it was away, so the lists in use are asked for again. */
export function refreshCatalogs(conn: Connection) {
  const machine = machineKey(conn);
  for (const key of Object.keys(useCatalogs.getState().entries)) {
    const [m, provider, account] = key.split("|");
    if (m === machine) void loadCatalog(conn, provider as Provider, account, true);
  }
}
