import { useEffect } from "react";
import type { ModelCatalog, Provider } from "@crosstalk/shared";
import type { Connection } from "./api";
import { catalogKey, loadCatalog, useCatalogs } from "./catalogs";
import { machineKey } from "./machines";
import { useStore } from "./store";

/**
 * An agent's model list on a machine (the open one, unless `connection` names another): loaded when first needed,
 * then kept live by the hub's "models" events. `failed`: it couldn't be had at all. A null provider asks for nothing.
 */
export function useCatalog(provider: Provider | null, account: string | null | undefined, connection?: Connection | null): { catalog: ModelCatalog | null; failed: boolean } {
  const active = useStore((s) => s.conn);
  const conn = connection ?? active;
  const key = provider && conn ? catalogKey(machineKey(conn), provider, account) : "";
  const entry = useCatalogs((s) => (key ? s.entries[key] : undefined));
  useEffect(() => {
    if (provider && conn) void loadCatalog(conn, provider, account);
  }, [key, conn?.token]); // eslint-disable-line react-hooks/exhaustive-deps
  return { catalog: entry?.catalog ?? null, failed: !!entry?.failed && !entry.catalog };
}
