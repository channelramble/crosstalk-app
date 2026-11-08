import { useEffect, useRef, useState } from "react";
import type { AccountSpend, SpendSummary } from "@crosstalk/shared";
import { api, ApiError } from "./api";
import { hubStore, useStore } from "./store";
import { useReconnected } from "./useReconnected";

/**
 * Asks the hub what each account has cost and puts it in the machine's store, where the `spend` events keep it fresh
 * (the chat's Raise limit and the notices read it from there). An event that came while this was on its way is newer.
 */
export async function loadSpend(): Promise<SpendSummary> {
  const key = useStore.getState().active;
  const before = hubStore(key)?.getState().spend ?? null;
  const summary = await api<SpendSummary>("GET", "/api/spend");
  const store = hubStore(key);
  if (store && store.getState().spend === before) store.setState({ spend: summary.accounts });
  return summary;
}

/** An account the hub just changed (its limit), put in the list the machine keeps. */
function keepAccount(updated: AccountSpend) {
  if (!updated?.account) return;
  hubStore(useStore.getState().active)?.setState((s) => {
    const list = s.spend ?? [];
    const at = list.findIndex((a) => a.provider === updated.provider && a.account === updated.account);
    return { spend: at >= 0 ? list.map((a, i) => (i === at ? updated : a)) : [...list, updated] };
  });
}

/** Sets an account's limit, or removes it (`limitUsd` null); the hub answers with the account as it is now. */
export async function setBudget(a: Pick<AccountSpend, "provider" | "account">, body: { limitUsd: number | null; period?: "month" | "total" }): Promise<AccountSpend> {
  const updated = await api<AccountSpend>("PUT", `/api/spend/budgets/${a.provider}/${encodeURIComponent(a.account)}`, body);
  keepAccount(updated);
  return updated;
}

/** What Settings → Costs shows: the accounts (kept live by the store), where prices came from, and how loading went. */
export function useSpendSummary() {
  const accounts = useStore((s) => s.spend);
  const [prices, setPrices] = useState<SpendSummary["prices"]>(null);
  const [error, setError] = useState<{ message: string; older: boolean } | null>(null);
  const request = useRef(0);
  const reload = () => {
    const id = ++request.current;
    setError(null);
    loadSpend()
      .then((summary) => {
        if (id === request.current) setPrices(summary.prices ?? null);
      })
      .catch((e) => {
        if (id === request.current) setError({ message: e instanceof Error ? e.message : String(e), older: e instanceof ApiError && e.status === 404 });
      });
  };
  useEffect(() => {
    reload();
    return () => {
      request.current++;
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  // The hub came back (it restarted, the phone woke): what's shown may be old.
  useReconnected(reload);
  return { accounts, prices, error, reload };
}
