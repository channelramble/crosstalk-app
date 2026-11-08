import { useMemo, useState } from "react";
import { ChevronRight, Settings, Users } from "lucide-react";
import { CHAT_PROVIDERS, PROVIDER_INFO, type ChatProvider, type UsageWindow } from "@crosstalk/shared";
import { accountKey } from "../accounts";
import { isUnread, membersByRoom } from "../chatList";
import { groupNames } from "../groupChat";
import { chatIdentity } from "../chatIdentity";
import { GroupAvatar } from "./GroupAvatar";
import { agentReady, useMachines, useStore } from "../store";
import { useSidebar } from "../sidebar";
import { StarterList, useChatStarters } from "./NewChatMenu";
import { ChatAvatar, Logo, ProviderAvatar, timeAgo, timeUntil, useInterval } from "../ui";
import { ApprovalCard } from "./ApprovalCard";
import { SidebarButton } from "./ChatSidebar";
import { MachinePicker, MachineTag } from "./MachinePicker";
import { WelcomeCard } from "./WelcomeCard";

/** The first screen: pick the agent to work with. */
export function HomeScreen() {
  const setView = useStore((s) => s.setView);
  const openRoom = useStore((s) => s.openRoom);
  const setCreating = useSidebar((s) => s.setCreating);
  // The latest chats, and what's waiting for you, on every machine.
  const machines = useMachines((m) => m.list);
  const multi = machines.length > 1;
  const anyReady = machines.some((m) => CHAT_PROVIDERS.some((p) => agentReady(m, p)));
  // The models of your own, offered here as in the New chat menu: the services added, and the servers running on this
  // machine that aren't added yet (one tap adds and starts).
  const starters = useChatStarters();
  const recent = useMemo(
    () =>
      machines
        .flatMap((m) => {
          const byRoom = membersByRoom(m.members);
          // What each chat is: its AI service and model, or its agent (chatIdentity.ts); a group chat lists its agents.
          return Object.values(m.rooms)
            .filter((r) => r.chat)
            .map((r) => ({ r, machine: m.name, group: r.chat?.group ? byRoom.get(r.id) ?? [] : null, identity: chatIdentity(r, r.chat?.group ? undefined : byRoom.get(r.id)?.[0], m.accounts, m.poolOffer) }));
        })
        .sort((a, b) => b.r.updatedAt - a.r.updatedAt)
        .slice(0, 4),
    [machines],
  );
  const approvals = useMemo(
    () =>
      machines
        .flatMap((m) => Object.values(m.approvals).filter((a) => a.status === "pending").map((a) => ({ a, machine: m })))
        .sort((x, y) => x.a.createdAt - y.a.createdAt),
    [machines],
  );
  // "5m ago" moves on by itself.
  const [, tick] = useState(0);
  useInterval(() => tick((n) => n + 1), 60_000);
  return (
    <>
      <header className="topbar" data-tauri-drag-region>
        <SidebarButton />
        <Logo />
        <div className="titles">
          <h1>Crosstalk</h1>
        </div>
        <MachinePicker />
        <button className="icon-btn" onClick={() => setView("settings")} aria-label="Settings" title="Settings">
          <Settings size={20} />
        </button>
      </header>
      <div className="page">
        <div className="page-inner">
          <WelcomeCard />
          <h2 className="picker-title">What agent do you want to use?</h2>
          <div className="agent-picker">
            {CHAT_PROVIDERS.map((p) => (
              <AgentCard key={p} provider={p} />
            ))}
          </div>
          {/* Several of them in one chat, each with its own model: New chat's Group chat, from here too. */}
          <button className="btn small group-start" disabled={!anyReady} onClick={() => setCreating({ kind: "group" })}>
            <Users size={15} aria-hidden="true" /> Start a group chat
          </button>

          <StarterList
            rows={starters.yours}
            onPick={setCreating}
            help="Models of your own. One tap starts a chat on it; a server found running here is added first."
          />

          {approvals.length > 0 && (
            <section style={{ marginTop: 22 }} aria-label="Waiting for you">
              <h3 className="section-title">Waiting for you</h3>
              {approvals.map(({ a, machine }) => (
                <div key={`${machine.key}/${a.id}`} className="waiting-item">
                  <div className="waiting-chat">
                    <button className="link-btn small ellipsis" onClick={() => openRoom(a.roomId)}>
                      {machine.rooms[a.roomId]?.name ?? "Chat"}
                    </button>
                    {multi && <MachineTag name={machine.name} />}
                  </div>
                  <ApprovalCard approval={a} member={machine.members[a.memberId]} machine={machine.key} />
                </div>
              ))}
            </section>
          )}

          {recent.length > 0 && (
            <section style={{ marginTop: 22 }} aria-label="Recent chats">
              <h3 className="section-title">Recent</h3>
              <div className="list-group">
                {recent.map(({ r, machine, group, identity }) => {
                  const unread = isUnread(r);
                  return (
                    <div key={r.id} className={`list-row ${unread ? "unread" : ""}`} role="button" tabIndex={0} onClick={() => openRoom(r.id)} onKeyDown={(e) => e.key === "Enter" && openRoom(r.id)}>
                      {group ? <GroupAvatar members={group} size="sm" /> : <ChatAvatar identity={identity} size="sm" />}
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div className="title ellipsis">{r.name}</div>
                        <div className="subtitle ellipsis">
                          {group ? groupNames(group) || "Group chat" : identity.name} · {timeAgo(r.updatedAt)}
                        </div>
                      </div>
                      {multi && <MachineTag name={machine} />}
                      {unread && <span className="reply-dot" aria-label="New reply" title="New reply" />}
                      <ChevronRight size={18} className="muted" />
                    </div>
                  );
                })}
              </div>
            </section>
          )}
        </div>
      </div>
    </>
  );
}

function AgentCard({ provider }: { provider: ChatProvider }) {
  const openAgent = useStore((s) => s.openAgent);
  const status = useStore((s) => s.providers[provider]);
  const signedIn = useStore((s) => Object.values(s.accounts).some((a) => a.provider === provider && a.signedIn)) || !!status?.signedIn;
  const usage = useStore((s) => s.usage[accountKey(provider, "default")]);
  const working = useStore((s) => Object.values(s.members).filter((m) => m.provider === provider && s.rooms[m.roomId]?.chat && !s.rooms[m.roomId]?.chat?.group && ["thinking", "working", "approval"].includes(m.status)).length);
  const info = PROVIDER_INFO[provider];
  const state = !status?.checkedAt ? "Checking…" : !status.installed ? "Not installed" : signedIn ? null : "Sign in needed";
  const windows = (usage?.windows ?? []).filter((w) => w.usedPercent !== null).slice(0, 2);
  return (
    <button className="agent-card" onClick={() => openAgent(provider)} style={{ ["--c" as string]: info.color }}>
      <div className="row" style={{ gap: 12 }}>
        <ProviderAvatar provider={provider} size="lg" />
        <div style={{ flex: 1, minWidth: 0, textAlign: "left" }}>
          <div className="agent-card-name">{info.name}</div>
          <div className="muted small">
            {info.vendor}
            {usage?.plan ? ` · ${usage.plan}` : ""}
          </div>
        </div>
        <ChevronRight size={20} className="muted" />
      </div>
      {state && <div className="pill orange" style={{ alignSelf: "flex-start" }}>{state}</div>}
      {working > 0 && <div className="pill blue" style={{ alignSelf: "flex-start" }}>{working === 1 ? "Working in 1 chat" : `Working in ${working} chats`}</div>}
      {windows.length > 0 && (
        <div className="agent-card-usage">
          {windows.map((w) => (
            <UsageLine key={w.label} w={w} />
          ))}
        </div>
      )}
    </button>
  );
}

export function UsageLine({ w }: { w: UsageWindow }) {
  const pct = Math.max(0, Math.min(100, Math.round(w.usedPercent ?? 0)));
  return (
    <div className="usage-line">
      <span className="usage-label">{w.label}</span>
      <div className={`meter ${pct >= 90 ? "full" : pct >= 70 ? "warn" : ""}`} aria-label={`${w.label}: ${pct}% used`}>
        <i style={{ ["--fill" as string]: pct / 100 }} />
      </div>
      <span className="usage-pct">
        {pct}%{w.resetsAt ? <span className="muted"> · {timeUntil(w.resetsAt)}</span> : null}
      </span>
    </div>
  );
}
