import { useEffect, useId, useState, type ReactNode } from "react";
import { CHAT_PROVIDERS, EFFORT_LABELS, PROVIDER_INFO, helperAccountLabel, type AgentAccount, type HelpersOn, type HubSettings, type Provider } from "@crosstalk/shared";
import { api, type Connection } from "../api";
import { useStore } from "../store";
import { useCatalog } from "../useCatalog";
import { ModelSelectOptions } from "./ModelChoices";

/**
 * "Helpers run on": who does helper work for a chat's agent. The agent's own helpers (today's, on the chat's own
 * account, with the model picked for them), or another account of this machine: the same agent on an API key, another
 * agent, a service, one of your own models (hub/src/helpers.ts runs those). One control, used in a chat's model menu
 * and settings, in New chat's More options, and in Settings → Agents together as what new chats start with.
 *
 * Self-contained on purpose: it takes the choice and gives it back, and reads the machine's accounts and the picked
 * account's models itself. `own`: the chat's agent and account (left out of the list, since that's its own helpers).
 * `ownModel`: the "which model" control for the agent's own helpers, shown under the choice while it's picked.
 */
export function HelpersOnControl({ value: saved, onChange: save, own, ownModel, tip, accounts, connection, compact = false, disabled = false }: { value: HelpersOn | null; onChange: (v: HelpersOn | null) => void; own?: { provider: Provider; account: string }; ownModel?: ReactNode; /** A "?" for beside the words (New chat's). */ tip?: ReactNode; accounts?: Record<string, AgentAccount>; connection?: Connection; compact?: boolean; disabled?: boolean }) {
  // What was just picked shows at once, while the save is on its way; what the chat (or the machine) says wins as soon as
  // it says something else.
  const [value, setValue] = useState(saved);
  const said = JSON.stringify(saved ?? null);
  useEffect(() => setValue(saved), [said]); // eslint-disable-line react-hooks/exhaustive-deps
  const onChange = (v: HelpersOn | null) => {
    setValue(v);
    save(v);
  };
  const stored = useStore((s) => s.accounts);
  const all = Object.values(accounts ?? stored);
  const options = helperAccounts(all, own);
  const key = value ? `${value.provider}:${value.account}` : "";
  const picked = value ? options.find((o) => o.key === key) : undefined;
  const { catalog } = useCatalog(value ? value.provider : null, value?.account, connection);
  const models = catalog?.models ?? [];
  const model = value?.model ? models.find((m) => m.id === value.model || m.resolvedModel === value.model) : undefined;
  const levels = (model ?? models.find((m) => m.isDefault))?.efforts ?? [];
  const helpId = useId();
  const ownWords = own ? `${PROVIDER_INFO[own.provider]?.name ?? "The agent"}'s own helpers` : "Each agent's own helpers";
  const pick = (k: string) => {
    const o = options.find((x) => x.key === k);
    onChange(o ? { provider: o.account.provider, account: o.account.id, ...(value?.fallback === false ? { fallback: false } : {}) } : null);
  };
  const row = compact ? "compact-row helper-row" : "field";
  return (
    <div className={`helpers-on${compact ? " compact" : ""}`}>
      {/* Not a <label>: the "?" beside the words is a button, and a label would hand it every tap on them. */}
      <div className={row}>
        <span className="tip-line">
          <span>Helpers run on</span>
          {tip}
        </span>
        <select className="select" aria-label="Helpers run on" aria-describedby={helpId} value={picked || !value ? key : "__gone__"} disabled={disabled} onChange={(e) => pick(e.target.value)}>
          <option value="">{ownWords}</option>
          {options.map((o) => (
            <option key={o.key} value={o.key} disabled={o.account.signedIn === false && o.key !== key}>
              {o.label}
              {o.account.signedIn === false ? " (signed out)" : ""}
            </option>
          ))}
          {value && !picked && <option value="__gone__">An account that was removed</option>}
        </select>
        <span className={compact ? "pop-note" : "help"} id={helpId}>
          {!value
            ? "Helpers are the extra agents your agent starts for parts of a job. Its own run on the chat's account."
            : picked
              ? `Your agent hands helper work to ${picked.label}, which pays for it. Each helper shows in the chat while it works.`
              : "That account isn't on this machine any more. Pick another, or the agent's own helpers."}
        </span>
      </div>
      {!value && ownModel}
      {value && picked && (
        <>
          <label className={row}>
            <span>Helper model</span>
            <select className="select" aria-label="Helper model" value={model ? model.id : value.model ?? ""} disabled={disabled} onChange={(e) => onChange({ ...value, model: e.target.value || null, effort: null })}>
              <option value="">Its default model</option>
              <ModelSelectOptions models={models} value={(m) => m.id} text={(m) => m.label} />
              {value.model && !model && <option value={value.model}>{value.model}</option>}
            </select>
          </label>
          {levels.length > 0 && (
            <label className={row}>
              <span>Helper effort</span>
              <select className="select" aria-label="Helper effort" value={value.effort && levels.includes(value.effort) ? value.effort : ""} disabled={disabled} onChange={(e) => onChange({ ...value, effort: e.target.value || null })}>
                <option value="">Its default</option>
                {levels.map((l) => (
                  <option key={l} value={l}>
                    {EFFORT_LABELS[l] ?? l}
                  </option>
                ))}
              </select>
            </label>
          )}
          <label className="helpers-on-tick">
            <input type="checkbox" checked={value.fallback !== false} disabled={disabled} onChange={(e) => onChange({ ...value, fallback: e.target.checked })} />
            <span>Use the agent's own helpers when that account can't run one</span>
          </label>
        </>
      )}
    </div>
  );
}

/** The accounts that can do helper work, as the list names them: the chat's own agent's first, then the rest. */
export function helperAccounts(all: readonly AgentAccount[], own?: { provider: Provider; account: string }): { key: string; label: string; account: AgentAccount }[] {
  const able = all.filter((a) => (CHAT_PROVIDERS as readonly string[]).includes(a.provider) && !(own && a.provider === own.provider && a.id === own.account));
  const rank = (a: AgentAccount) => (own && a.provider === own.provider ? 0 : 1) * 10 + (a.kind === "apikey" ? 0 : a.kind === "endpoint" ? 2 : 1);
  return [...able]
    .sort((a, b) => rank(a) - rank(b))
    .map((a) => {
      const name = helperAccountLabel(a, all);
      // A service or one of your own models is driven by an agent: say which, since that is who does the work.
      return { key: `${a.provider}:${a.id}`, label: a.kind === "endpoint" ? `${name} · with ${PROVIDER_INFO[a.provider]?.name ?? a.provider}` : name, account: a };
    });
}

/** A choice as the hub keeps it: nothing but what was picked (no empty model or effort). */
export function cleanHelpersOn(v: HelpersOn | null | undefined): HelpersOn | null {
  if (!v) return null;
  return { provider: v.provider, account: v.account, ...(v.model ? { model: v.model } : {}), ...(v.effort ? { effort: v.effort } : {}), ...(v.fallback === false ? { fallback: false } : {}) };
}

/** What the picked account is called, for a line that says who helps ("Claude API key"); null for the agent's own. */
export function helpersOnLabel(v: HelpersOn | null | undefined, all: readonly AgentAccount[]): string | null {
  if (!v) return null;
  const a = all.find((x) => x.provider === v.provider && x.id === v.account);
  return a ? helperAccountLabel(a, all) : "an account that was removed";
}

const defaults = new Map<string, Promise<HelpersOn | null>>();

/**
 * What new chats on this machine start with (Settings → Agents together), for a form that makes one: `undefined` until
 * it's known. Asked once per machine while the app is open; a save in Settings forgets it (forgetHelpersDefault).
 */
export function useHelpersDefault(connection?: Connection | null, wanted = true): HelpersOn | null | undefined {
  const active = useStore((s) => s.conn);
  const conn = wanted ? connection ?? active : null;
  const [value, setValue] = useState<HelpersOn | null | undefined>(undefined);
  const where = conn ? `${conn.baseUrl}|${conn.token}` : "";
  useEffect(() => {
    if (!conn) return;
    let live = true;
    let asked = defaults.get(where);
    if (!asked) {
      asked = api<HubSettings>("GET", "/api/settings/hub", undefined, conn).then((s) => s.helpers ?? null);
      defaults.set(where, asked);
      asked.catch(() => defaults.delete(where));
    }
    asked.then((v) => live && setValue(v)).catch(() => live && setValue(null));
    return () => {
      live = false;
    };
  }, [where]); // eslint-disable-line react-hooks/exhaustive-deps
  return value;
}

export function forgetHelpersDefault() {
  defaults.clear();
}
