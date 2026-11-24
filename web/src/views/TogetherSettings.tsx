import { useEffect, useRef, useState } from "react";
import { CHAT_PROVIDERS, DEFAULT_ACCOUNT, PROVIDER_INFO, helperAccountLabel, type AgentAccount, type HelpersOn, type HubSettings, type TeamworkSettings } from "@crosstalk/shared";
import { api } from "../api";
import { useStore } from "../store";
import { Switch } from "../ui";
import { useReconnected } from "../useReconnected";
import { HelpTip } from "./HelpTip";
import { HelpersOnControl, cleanHelpersOn, forgetHelpersDefault } from "./HelpersOn";

/**
 * This machine's settings as Settings → Agents together reads and saves them: loaded once, each change saved at once,
 * and what's shown put back to what the machine last said when a save fails (what's on screen is what agents get).
 */
function useHubSettings() {
  // This machine's: Settings opens anew when another machine is picked, and a save still on its way goes here.
  const connection = useRef(useStore.getState().conn).current;
  const [settings, setSettings] = useState<HubSettings | null>(null);
  const [error, setError] = useState("");
  const [saveError, setSaveError] = useState("");
  const [saving, setSaving] = useState(false);
  const saved = useRef<HubSettings | null>(null);
  const loads = useRef(0);
  const saves = useRef(0);
  const load = () => {
    const id = ++loads.current;
    setError("");
    api<HubSettings>("GET", "/api/settings/hub", undefined, connection)
      .then((s) => {
        if (id !== loads.current) return;
        saved.current = s;
        setSettings(s);
      })
      .catch((e) => id === loads.current && setError(e instanceof Error ? e.message : String(e)));
  };
  useEffect(() => {
    load();
    return () => {
      loads.current++;
      saves.current++;
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  useReconnected(() => {
    if (!settings) load();
  });
  /** `shown`: what the screen says while the save is on its way; `body`: what's sent. */
  const save = async (shown: HubSettings, body: Partial<HubSettings>) => {
    const id = ++saves.current;
    setSettings(shown);
    setSaveError("");
    setSaving(true);
    try {
      const s = await api<HubSettings>("PUT", "/api/settings/hub", body, connection);
      saved.current = s;
      if (id === saves.current) setSettings(s);
    } catch (e) {
      if (id !== saves.current) return;
      setSettings(saved.current);
      setSaveError(`Couldn't save: ${(e instanceof Error ? e.message : String(e)).replace(/[.\s]*$/, "")}. Change it again to retry.`);
    } finally {
      if (id === saves.current) setSaving(false);
    }
  };
  return { settings, saved, error, load, save, saving, saveError };
}

function Loading({ error, load }: { error: string; load: () => void }) {
  return error ? (
    <div role="alert">
      <p className="small">Couldn't load this setting: {error}</p>
      <button className="btn small" onClick={load}>
        Retry
      </button>
    </div>
  ) : (
    <p className="muted small" role="status">
      Loading…
    </p>
  );
}

function Saved({ saving, saveError }: { saving: boolean; saveError: string }) {
  return saveError ? (
    <p role="alert" className="small" style={{ color: "var(--red)", marginBottom: 0 }}>
      {saveError}
    </p>
  ) : (
    <p className="help" role="status" style={{ marginBottom: 0 }}>
      {saving ? "Saving…" : "Saves as you change it."}
    </p>
  );
}

export const HELPERS_ON = "Helpers run on";
export const QUESTIONS = "Let agents ask another agent a quick question";

/** Who does helper work in new chats: each agent's own helpers, or another account of this machine's. */
export function HelpersOnCard() {
  const { settings, error, load, save, saving, saveError } = useHubSettings();
  const put = (v: HelpersOn | null) => {
    if (!settings) return;
    const helpers = cleanHelpersOn(v);
    forgetHelpersDefault();
    void save({ ...settings, helpers }, { helpers });
  };
  return (
    <section className="card settings-target together-card" id="helpers-on" aria-label={HELPERS_ON}>
      <div style={{ fontWeight: 600 }}>Who does helper work</div>
      {settings ? (
        <>
          <div className="help tip-line">
            <span>What new chats start with. A helper is an agent that your agent starts for part of a job.</span>
            <HelpTip label="More about helpers on another account">
              An agent's own helpers use the chat's account, so a plan's limits go on them too. Pick another account (the same agent on an API key, another agent, a service or one of your own models) and your agent hands helper work to it instead. A helper works in the chat's folder, may do what the chat may do without asking, and asks you for anything more with a card in that chat. Its cost is counted on its own account. Each chat can choose differently in its own settings; chats you already have keep what they have.
            </HelpTip>
          </div>
          <HelpersOnControl value={settings.helpers ?? null} onChange={put} />
          <Saved saving={saving} saveError={saveError} />
        </>
      ) : (
        <Loading error={error} load={load} />
      )}
    </section>
  );
}

/** The accounts that can be asked a quick question, as the list names them. */
function askChoices(all: readonly AgentAccount[]) {
  return all.filter((a) => (CHAT_PROVIDERS as readonly string[]).includes(a.provider)).map((a) => ({ key: `${a.provider}:${a.id}`, account: a, label: a.kind === "endpoint" ? `${helperAccountLabel(a, all)} · with ${PROVIDER_INFO[a.provider]?.name ?? a.provider}` : helperAccountLabel(a, all) }));
}

/**
 * Whether agents may ask another agent one read-only question, and whom. With nobody picked it's the other one of Claude
 * Code and Codex on its main sign-in, as it always was (shown ticked). How often they ask and when a nearly used-up plan
 * is spared stay fixed: one question per reply, never above 80% of a limit.
 */
export function QuestionsCard() {
  const { settings, saved, error, load, save, saving, saveError } = useHubSettings();
  const accounts = useStore((s) => s.accounts);
  const tw = settings?.teamwork ?? null;
  const choices = askChoices(Object.values(accounts));
  const ticked = (key: string) => (tw?.who ? tw.who.some((w) => `${w.provider}:${w.account}` === key) : key.endsWith(`:${DEFAULT_ACCOUNT}`));
  const put = (next: TeamworkSettings) => {
    if (!settings) return;
    // What the machine saved for the rest goes back untouched.
    void save({ ...settings, teamwork: next }, { teamwork: { ...(saved.current?.teamwork ?? next), enabled: next.enabled, ...(next.who ? { who: next.who } : {}) } });
  };
  const tick = (key: string, on: boolean) => {
    if (!tw) return;
    const now = choices.filter((c) => (c.key === key ? on : ticked(c.key))).map((c) => ({ provider: c.account.provider, account: c.account.id }));
    put({ ...tw, who: now });
  };
  return (
    <section className="card settings-target together-card" id="teamwork" aria-label={QUESTIONS}>
      <div className="row">
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontWeight: 600 }}>{QUESTIONS}</div>
          {tw ? (
            <div className="help tip-line" id="teamwork-help">
              <span>Your agent can ask another one a question when a second opinion really helps.</span>
              <HelpTip label="More about quick questions">
                The one asked sees only the question, never your chat. It can read the folder but not change it, answers one question per reply, and isn't asked when its plan is nearly used up or its spending limit is reached. A question to an account you pay for by use costs a little there.
              </HelpTip>
            </div>
          ) : (
            <Loading error={error} load={load} />
          )}
        </div>
        {tw && <Switch checked={tw.enabled} onChange={(v) => put({ ...tw, enabled: v })} label={QUESTIONS} describedBy="teamwork-help" />}
      </div>
      {tw?.enabled && choices.length > 0 && (
        <div className="together-who" role="group" aria-label="Who they can ask">
          <div className="together-who-title">Who they can ask</div>
          {choices.map((c) => (
            <label key={c.key}>
              <input type="checkbox" checked={ticked(c.key)} onChange={(e) => tick(c.key, e.target.checked)} />
              <span>
                {c.label}
                {c.account.signedIn === false ? " (signed out)" : ""}
              </span>
            </label>
          ))}
        </div>
      )}
      {tw && <Saved saving={saving} saveError={saveError} />}
    </section>
  );
}
