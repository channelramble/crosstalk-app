// Settings' first screen: what needs you (only when something does), a search field, then the pages as rows. The
// map of pages is settingsTabs.ts; what needs you is needsYou.ts; each row's one line is settingsIndex.ts.
import { UpdateReady } from "./UpdateReady";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { Bot, ChevronRight, Cpu, Gauge, MessageSquarePlus, Search, Server, Smartphone, UserRound, X } from "lucide-react";
import type { HubSettings, Provider, SetupChecklist } from "@crosstalk/shared";
import { accountKey } from "../accounts";
import { api } from "../api";
import { needsYou, type Need } from "../needsYou";
import { pushSupported } from "../push";
import { pageLine } from "../settingsIndex";
import { searchSettings, SETTINGS_PAGES, type SettingsPageId } from "../settingsTabs";
import { PHONE_SIGN_IN } from "../signIn";
import { openSignIn } from "../signInSheet";
import { useMachines, useStore } from "../store";
import { useReconnected } from "../useReconnected";
import { useZoom } from "../zoom";
import { InstallBox, useAgentInstall } from "./AgentInstall";
import { useMachineName } from "./MachinePicker";

const ICONS: Record<SettingsPageId, ReactNode> = {
  accounts: <UserRound size={20} aria-hidden />,
  "new-chats": <MessageSquarePlus size={20} aria-hidden />,
  together: <Bot size={20} aria-hidden />,
  usage: <Gauge size={20} aria-hidden />,
  device: <Smartphone size={20} aria-hidden />,
  machines: <Server size={20} aria-hidden />,
  models: <Cpu size={20} aria-hidden />,
};

/** `onShow`: opens a page, or a section inside one, by its id. */
export function SettingsIndex({ onShow }: { onShow: (name: string) => void }) {
  const [query, setQuery] = useState("");
  const hits = searchSettings(query);
  const searching = query.trim().length > 0;
  return (
    <>
      {/* An update waiting for the chats to go quiet, with Restart now: here as on Home. */}
      <UpdateReady />
      <NeedsYou onShow={onShow} />
      <label className="settings-search">
        <Search size={17} aria-hidden />
        <input type="search" placeholder="Search settings" aria-label="Search settings" value={query} onChange={(e) => setQuery(e.target.value)} enterKeyHint="search" autoCapitalize="off" autoCorrect="off" spellCheck={false} />
        {searching && (
          <button type="button" className="settings-search-clear" aria-label="Clear the search" onClick={() => setQuery("")}>
            <X size={16} aria-hidden />
          </button>
        )}
      </label>
      {searching ? (
        <div role="region" aria-label="Search results" aria-live="polite">
          {hits.length ? (
            <div className="list-group settings-pages">
              {hits.map((h) => (
                <button key={`${h.page}/${h.section ?? ""}`} type="button" className="list-row settings-page-row" onClick={() => onShow(h.section ?? h.page)}>
                  <span className="settings-page-icon">{ICONS[h.page]}</span>
                  <span className="row-text">
                    <span className="title">{h.title}</span>
                    <span className="subtitle">{h.where}</span>
                  </span>
                  <ChevronRight size={18} aria-hidden className="settings-page-chev" />
                </button>
              ))}
            </div>
          ) : (
            <p className="help settings-no-hits">Nothing in Settings matches “{query.trim()}”. Try another word, like key, limit or text size.</p>
          )}
        </div>
      ) : (
        <PageRows onShow={onShow} />
      )}
    </>
  );
}

/** The pages as rows: icon, name, and one line saying its state or what's in it. */
function PageRows({ onShow }: { onShow: (name: string) => void }) {
  const accounts = useStore((s) => s.accounts);
  const usage = useStore((s) => s.usage);
  const spend = useStore((s) => s.spend);
  const templates = useStore((s) => s.templates?.length ?? null);
  const storage = useStore((s) => s.storage);
  const imageEditor = useStore((s) => s.imageEditor);
  const hubId = useStore((s) => s.hub?.id);
  const machines = useMachines((m) => m.list);
  const zoom = useZoom();
  // Teamwork and reaching other chats, for the Agents together line: read once, quietly (the page itself says a failure).
  const [settings, setSettings] = useState<HubSettings | null>(null);
  const request = useRef(0);
  const load = () => {
    const id = ++request.current;
    api<HubSettings>("GET", "/api/settings/hub").then(
      (s) => id === request.current && setSettings(s),
      () => {},
    );
  };
  useEffect(() => {
    load();
    return () => void request.current++;
  }, [hubId]); // eslint-disable-line react-hooks/exhaustive-deps
  useReconnected(() => {
    if (!settings) load();
  });
  // Whether this browser may show notifications: what it says itself, without asking the machine.
  const notifications = pushSupported() ? Notification.permission === "granted" : null;
  const facts = { accounts, usage, spend, settings, templates, machines: machines.map((m) => m.name), storage, imageEditor, notifications, zoom: zoom.chosen };
  return (
    <nav className="list-group settings-pages" aria-label="Settings pages">
      {SETTINGS_PAGES.map((p) => (
        <button key={p.id} type="button" className="list-row settings-page-row" onClick={() => onShow(p.id)}>
          <span className="settings-page-icon">{ICONS[p.id]}</span>
          <span className="row-text">
            <span className="title">{p.label}</span>
            <span className="subtitle">{pageLine(p.id, facts)}</span>
          </span>
          <ChevronRight size={18} aria-hidden className="settings-page-chev" />
        </button>
      ))}
    </nav>
  );
}

/**
 * What only you can do, each with its button: sign an agent in, install one, see what the Mac is asking. Hidden when
 * there's nothing. The checklist is read quietly: a machine without one (or one that can't be asked just now) still
 * gets the rows the app knows by itself.
 */
function NeedsYou({ onShow }: { onShow: (name: string) => void }) {
  const machine = useMachineName();
  const providers = useStore((s) => s.providers);
  const accounts = useStore((s) => s.accounts);
  const signIns = useStore((s) => s.signIns);
  const macDialogs = useStore((s) => s.macDialogs);
  const updateShown = useStore((s) => !!s.hub?.update);
  const hubId = useStore((s) => s.hub?.id);
  const [list, setList] = useState<SetupChecklist | null>(null);
  const request = useRef(0);
  const load = () => {
    const id = ++request.current;
    api<SetupChecklist>("GET", "/api/setup").then(
      (c) => id === request.current && setList(c),
      () => {},
    );
  };
  // Asked again when a sign-in or an install changes: the checklist's other items can change with them.
  const agents = JSON.stringify(Object.values(providers).map((p) => [p?.provider, p?.installed, p?.signedIn]));
  useEffect(() => {
    load();
    return () => void request.current++;
  }, [hubId, agents]); // eslint-disable-line react-hooks/exhaustive-deps
  useReconnected(load);
  const needs = needsYou({ machine, providers, accounts, signIns, macDialogs: macDialogs ?? [], list, updateShown });
  if (!needs.length) return null;
  return (
    <section className="card needs-you" aria-label="Needs you">
      <h2 className="needs-you-title">Needs you</h2>
      {needs.map((n) => (
        <NeedRow key={n.id} need={n} onShow={onShow} />
      ))}
    </section>
  );
}

function NeedRow({ need, onShow }: { need: Need; onShow: (name: string) => void }) {
  const machine = useMachineName();
  const phoneSignIn = useStore((s) => s.signIns !== null);
  const a = need.action;
  const press = (opener: HTMLElement) => {
    if (a.kind === "show") return onShow(a.section);
    if (a.kind !== "signin") return;
    // A machine that signs agents in from the phone does it in the sign-in sheet, right here; any other shows the
    // agent's own place in Accounts, where its Sign in opens a terminal on that machine.
    if (!phoneSignIn || !PHONE_SIGN_IN.includes(a.provider)) return onShow(`agent-${a.provider}`);
    const account = useStore.getState().accounts[accountKey(a.provider, a.account)];
    openSignIn({ provider: a.provider, account: a.account, accountLabel: a.accountLabel ?? account?.label ?? null, machineKey: useStore.getState().active, machine, opener });
  };
  return (
    <div className="need-row" role="group" aria-label={need.title}>
      <div className="need-text">
        <div className="need-title">{need.title}</div>
        <div className="help">{need.detail}</div>
      </div>
      {a.kind === "install" ? (
        <NeedInstall provider={a.provider} />
      ) : (
        <button type="button" className="btn small primary need-btn" onClick={(e) => press(e.currentTarget)}>
          {need.button}
        </button>
      )}
    </div>
  );
}

/** Install, followed in the row: one line that says how it's going, the installer's output while it runs. */
function NeedInstall({ provider }: { provider: Provider }) {
  const install = useAgentInstall(provider);
  return (
    <div className="need-install">
      <InstallBox install={install} idleAction="Install" />
    </div>
  );
}
