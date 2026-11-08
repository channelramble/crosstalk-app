// The New chat menu, wherever a chat is started: the sidebar's button, Home and an agent's screen all offer the same
// things — the agents, the AI services you've added, the servers running on this machine that aren't added yet, and a
// group chat. What goes in it is worked out in newChat.ts; this only draws it.

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { ChevronLeft, ChevronRight, Users } from "lucide-react";
import { CHAT_PROVIDERS, type LocalServer } from "@crosstalk/shared";
import { api } from "../api";
import { catalogKey, useCatalogs } from "../catalogs";
import { machineKey } from "../machines";
import { leave } from "../motion";
import { chatStarters, foldStarters, type NewChatTarget, type StarterRow, type Starters } from "../newChat";
import { agentReady, useMachines, useStore } from "../store";
import { ProviderAvatar, ServiceAvatar } from "../ui";

/** A look for model servers on this machine is kept this long: opening the menu again doesn't scan again. */
const SERVERS_KEPT_MS = 60_000;
let serversCache: { key: string; at: number; list: LocalServer[] } | null = null;

/**
 * Model servers answering on the open machine. Asked for only once something that lists them is on screen (`when`), and
 * kept for a minute, so opening the New chat menu never waits on a scan twice. A hub that can't look answers nothing,
 * and the menu simply has no servers in it.
 */
function useLocalServers(when: boolean): LocalServer[] {
  const conn = useStore((s) => s.conn);
  const key = conn ? machineKey(conn) : "";
  const [list, setList] = useState<LocalServer[]>(() => (serversCache?.key === key ? serversCache.list : []));
  useEffect(() => {
    if (!when || !conn) return;
    if (serversCache?.key === key && Date.now() - serversCache.at < SERVERS_KEPT_MS) {
      setList(serversCache.list);
      return;
    }
    let live = true;
    const done = (l: LocalServer[]) => {
      serversCache = { key, at: Date.now(), list: l };
      if (live) setList(l);
    };
    api<{ servers: LocalServer[] }>("GET", "/api/local-servers", undefined, conn).then((r) => done(Array.isArray(r?.servers) ? r.servers : []), () => done([]));
    return () => {
      live = false;
    };
  }, [when, key, conn?.token]); // eslint-disable-line react-hooks/exhaustive-deps
  return list;
}

/**
 * What a New chat menu offers on the open machine. `when`: whether to look for servers running here (only while
 * something that lists them is on screen).
 */
export function useChatStarters(when = true): Starters {
  const machines = useMachines((m) => m.list);
  const accounts = useStore((s) => s.accounts);
  const providers = useStore((s) => s.providers);
  const conn = useStore((s) => s.conn);
  const active = useStore((s) => s.active);
  const entries = useCatalogs((s) => s.entries);
  const multi = machines.length > 1;
  const here = machines.find((m) => m.key === active);
  const servers = useLocalServers(when);
  // The model pool of the open machine: one entry whatever state it's in (newChat.ts poolRow).
  const pool = useStore((s) => s.poolOffer);
  return chatStarters({
    // An agent can start a chat if it's ready on any machine (the New chat dialog asks which).
    ready: CHAT_PROVIDERS.filter((p) => machines.some((m) => agentReady(m, p))),
    accounts: Object.values(accounts),
    servers,
    installed: { claude: providers.claude?.installed, codex: providers.codex?.installed, opencode: providers.opencode?.installed },
    // The hub's live list for this account, where a screen has already asked for it: what it says about the model's
    // tools. The menu never asks by itself — the New chat dialog does, and says what a no-tools model means.
    models: (a) => (conn ? entries[catalogKey(machineKey(conn), a.provider, a.id)]?.catalog?.models ?? null : null),
    machine: multi ? here?.name ?? null : null,
    pool,
    machineKey: active,
  });
}

/** One row of the menu: its avatar, its name, and a line saying the model it would run and where. */
export function StarterItem({ row, onPick }: { row: StarterRow; onPick: (t: NewChatTarget) => void }) {
  return (
    <button className="nc-item" role="menuitem" onClick={() => onPick(row.target)}>
      {row.where ? <ServiceAvatar where={row.where} size="sm" label={row.title} /> : <ProviderAvatar provider={row.provider} size="sm" />}
      <span className="nc-item-text">
        <span className="nc-item-title">
          <span className="ellipsis">{row.title}</span>
          {row.noTools && <span className="pill">No tools</span>}
        </span>
        <span className="nc-item-help">{row.help}</span>
      </span>
    </button>
  );
}

/**
 * The menu itself. With more services than fit a phone screen, the rest go behind "All your models", a second step with
 * a way back — the same two-step shape as the model menu's More models.
 *
 * It grows down from its button (motion-lists.css); closed, it's gone at once and a copy shrinks back into the button.
 * A step comes in from the side it's heading to: the menu stays, what's in it is drawn anew (`.nc-step`, keyed by step).
 */
export function NewChatMenu({ starters, onPick, label = "New chat" }: { starters: Starters; onPick: (t: NewChatTarget) => void; label?: string }) {
  const [step, setStep] = useState<"first" | "all">("first");
  // Which way the last change of step went: on, to all your models, or back.
  const [toward, setToward] = useState<"" | "fwd" | "back">("");
  const menu = useRef<HTMLDivElement>(null);
  const back = useRef<HTMLButtonElement>(null);
  const opener = useRef<HTMLButtonElement>(null);
  useLayoutEffect(() => {
    const el = menu.current;
    return () => leave(el, "menu");
  }, []);
  // Focus follows a change of step, so a keyboard or screen reader never lands on nothing.
  const moved = useRef(false);
  useEffect(() => {
    if (moved.current) (step === "all" ? back.current : opener.current)?.focus();
  }, [step]);
  const go = (to: "first" | "all") => {
    moved.current = true;
    setToward(to === "all" ? "fwd" : "back");
    setStep(to);
  };
  // The models of your own, in one order for every screen (newChat.ts `yours`): the pool, your services, servers to add.
  const rows = starters.yours;
  const { first, folded } = foldStarters(rows);
  if (step === "all" && folded.length > 0) {
    return (
      <div ref={menu} className="csb-new-menu" role="menu" aria-label="All your models">
        <div key="all" className={`nc-step ${toward}`}>
          {/* A menu holds menu items, so the step's title is the menu's own name and this row is the way back. */}
          <button ref={back} type="button" role="menuitem" className="nc-item nc-back" onClick={() => go("first")}>
            <ChevronLeft size={18} aria-hidden="true" />
            <span className="nc-item-text">
              <span className="nc-item-title">All your models</span>
              <span className="nc-item-help">Back to Claude Code and Codex</span>
            </span>
          </button>
          {rows.map((row) => (
            <StarterItem key={row.id} row={row} onPick={onPick} />
          ))}
        </div>
      </div>
    );
  }
  return (
    <div ref={menu} className="csb-new-menu" role="menu" aria-label={label}>
      <div key="first" className={`nc-step ${toward}`}>
        {starters.agents.map((row) => (
          <StarterItem key={row.id} row={row} onPick={onPick} />
        ))}
        {first.map((row) => (
          <StarterItem key={row.id} row={row} onPick={onPick} />
        ))}
        {folded.length > 0 && (
          <button ref={opener} type="button" role="menuitem" className="nc-item nc-more" onClick={() => go("all")} aria-label={`All your models (${rows.length})`}>
            <span className="nc-item-text">
              <span className="nc-item-title">
                <span className="ellipsis">All your models</span>
                <span className="pop-badge">{rows.length}</span>
              </span>
            </span>
            <ChevronRight size={16} aria-hidden="true" />
          </button>
        )}
        {/* Named by its text alone ("Group chat"), as it always has been. */}
        <button className="nc-item" role="menuitem" onClick={() => onPick({ kind: "group" })}>
          <span className="avatar sm group-mark" aria-hidden="true">
            <Users size={12} />
          </span>
          <span className="nc-item-text">
            <span className="nc-item-title">Group chat</span>
          </span>
        </button>
      </div>
    </div>
  );
}

/**
 * The same models as a list on a page (Home, and an agent's screen): "Your models", each one a tap to a new chat. Not
 * there at all when you have none.
 */
export function StarterList({ rows, onPick, title = "Your models", help }: { rows: StarterRow[]; onPick: (t: NewChatTarget) => void; title?: string; help?: string }) {
  if (!rows.length) return null;
  return (
    <section className="nc-list" aria-label={title}>
      <h3 className="section-title">{title}</h3>
      {help && <p className="help" style={{ margin: "0 0 8px" }}>{help}</p>}
      <div className="list-group">
        {rows.map((row) => (
          <button key={row.id} className="list-row nc-row" onClick={() => onPick(row.target)}>
            {row.where ? <ServiceAvatar where={row.where} size="sm" label={row.title} /> : <ProviderAvatar provider={row.provider} size="sm" />}
            <div style={{ flex: 1, minWidth: 0 }}>
              {/* Flex, so a long name is cut with an ellipsis and the "No tools" mark still shows. */}
              <div className="title nc-item-title">
                <span className="ellipsis">{row.title}</span>
                {row.noTools && <span className="pill">No tools</span>}
              </div>
              <div className="subtitle ellipsis">{row.help}</div>
            </div>
            <ChevronRight size={18} className="muted" aria-hidden="true" />
          </button>
        ))}
      </div>
    </section>
  );
}
