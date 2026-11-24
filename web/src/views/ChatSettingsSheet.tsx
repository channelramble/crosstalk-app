import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { Brain, ChevronDown, Copy, MessageSquare, Plus, RotateCcw, ShieldCheck, Sparkles, Trash2, Users, UsersRound, Zap } from "lucide-react";
import { PROVIDER_INFO, groupAnswers, groupMode, helpersOf, isServiceOnlyAgent, permissionInfo, serviceCompactPoint, slugHandle, turnOrder, type ChatProvider, type Member, type Message, type ModelOption, type PermissionMode, type Room, type RoomDefaults } from "@crosstalk/shared";
import { api } from "../api";
import { accountKey, memberAccount } from "../accounts";
import { chatIdentity, identityWhere } from "../chatIdentity";
import { ANSWER_OPTIONS, hopsOf, moreLine, roundsOf } from "../groupChat";
import { SECTION_TITLES, effortName, agentLine, agentSections, asDefaults, foldKey, hasDefaults, heldLine, isBusy, memoryWords, openAt, startsLikeThis, whenWords, type SectionId, type SheetAt } from "../chatSettings";
import { nameEdit } from "../chatName";
import { contextSize } from "../models";
import { isPinned, pinChat, pinFailed } from "../pins";
import { settingsPath } from "../settingsTabs";
import { deleteRoomHere, useMachines, useStore } from "../store";
import { ChatAvatar, Dialog, MemberAvatar, Switch, formatTokens } from "../ui";
import { useAgentSettings, useChatContext, type AgentSettings } from "../useAgentSettings";
import { useCatalog } from "../useCatalog";
import { olderThan } from "../version";
import { AccountCards, EffortSteps, ModelPicker, Part, PermissionCards } from "./AgentChoices";
import { AgentDialog, ROLE_PRESETS } from "./AgentDialog";
import { HelperSelect, helperHelp } from "./AgentOptions";
import { AlwaysAllowedList } from "./AlwaysAllowed";
import { ChatCostLine } from "./ChatCost";
import { ExportMarkdownButton } from "./ExportMarkdownButton";
import { GroupAvatar } from "./GroupAvatar";
import { GroupHow } from "./GroupHow";
import { HelpersOnControl, cleanHelpersOn, helpersOnLabel } from "./HelpersOn";
import { UsageLine } from "./HomeScreen";
import { MenuItem } from "./ModelChoices";
import { TwoStepDialog } from "./TwoStepDialog";

const ORIGIN: Record<string, string> = { "claude-app": "the Claude app", "claude-cli": "the claude command", "codex-app": "the Codex app" };
const isReply = (m: Message) => m.authorKind === "agent" && !(m.status === "stopped" && !m.text.trim());
const ICONS: Record<SectionId, ReactNode> = {
  answers: <Sparkles size={17} aria-hidden="true" />,
  may: <ShieldCheck size={17} aria-hidden="true" />,
  helpers: <Users size={17} aria-hidden="true" />,
  memory: <Brain size={17} aria-hidden="true" />,
  agent: <MessageSquare size={17} aria-hidden="true" />,
  group: <UsersRound size={17} aria-hidden="true" />,
  chat: <MessageSquare size={17} aria-hidden="true" />,
};

/** Which sections are open, and the way to open or close one. */
interface Folds {
  open: (key: string) => boolean;
  toggle: (key: string) => void;
}

/**
 * One section of the sheet: a row that names it and says what's in force, which opens in place. Closed, the rows are
 * the chat's settings at a glance; open, the choices are big enough for a thumb.
 */
function Fold({ at, title, summary, icon, folds, children, level = 2 }: { at: string; title: string; summary: ReactNode; icon: ReactNode; folds: Folds; children: ReactNode; level?: 2 | 3 }) {
  const id = useId();
  const open = folds.open(at);
  return (
    <section className={`cs-fold${open ? " open" : ""}${level === 3 ? " inner" : ""}`} aria-label={title} data-fold={at}>
      <button type="button" className="cs-fold-head" aria-expanded={open} aria-controls={id} onClick={() => folds.toggle(at)}>
        <span className="cs-fold-icon">{icon}</span>
        <span className="cs-fold-text">
          <span className="cs-fold-title">{title}</span>
          <span className="cs-fold-sum">{summary}</span>
        </span>
        <ChevronDown size={17} className="cs-fold-chevron" aria-hidden="true" />
      </button>
      {open && (
        <div className="cs-fold-body" id={id}>
          {children}
        </div>
      )}
    </section>
  );
}

/**
 * A switch with its name and a sentence about it. It shows the new side as soon as it's flipped, while the save is on
 * its way; what the chat says wins as soon as it says something, and a save that failed (`onChange` answers false)
 * puts it back.
 */
function SwitchRow({ title, help, checked, onChange, icon, disabled }: { title: string; help?: ReactNode; checked: boolean; onChange: (v: boolean) => Promise<boolean> | void; icon?: ReactNode; disabled?: boolean }) {
  const [flipped, setFlipped] = useState<boolean | null>(null);
  useEffect(() => setFlipped(null), [checked]);
  return (
    <div className="cs-switch">
      {icon}
      <div className="cs-switch-text">
        <div className="cs-switch-title">{title}</div>
        {help && <div className="cs-note">{help}</div>}
      </div>
      <Switch
        checked={flipped ?? checked}
        label={title}
        disabled={disabled}
        onChange={(v) => {
          setFlipped(v);
          void Promise.resolve(onChange(v)).then((ok) => ok === false && setFlipped(null));
        }}
      />
    </div>
  );
}

/** A question asked once, in the app's own sheet, before something that changes how the agent runs. */
function AskOnce({ title, children, confirmLabel, danger = false, onConfirm, onClose }: { title: string; children: ReactNode; confirmLabel: string; danger?: boolean; onConfirm: () => Promise<unknown>; onClose: () => void }) {
  const [busy, setBusy] = useState(false);
  return (
    <Dialog
      title={title}
      onClose={() => !busy && onClose()}
      footer={
        <div className="row" style={{ gap: 8, justifyContent: "flex-end", width: "100%" }}>
          <button className="btn small" disabled={busy} onClick={onClose}>
            Cancel
          </button>
          <button
            className={`btn small ${danger ? "danger" : "primary"}`}
            disabled={busy}
            onClick={async () => {
              setBusy(true);
              try {
                await onConfirm();
              } finally {
                setBusy(false);
                onClose();
              }
            }}
          >
            {confirmLabel}
          </button>
        </div>
      }
    >
      <p className="small" style={{ margin: 0 }}>
        {children}
      </p>
    </Dialog>
  );
}

/**
 * "Use these for new chats too": the chat's account, model, effort, helpers' model and what it may do become what new
 * chats with this agent start with (Settings → New chats), without a trip to Settings. Only offered when they differ.
 */
function useNewChatDefaults(member: Member) {
  const service = useStore((st) => st.accounts[accountKey(member.provider, memberAccount(member))]?.kind === "endpoint");
  const offered = hasDefaults(member.provider, service);
  const [defaults, setDefaults] = useState<RoomDefaults | null>(null);
  useEffect(() => {
    if (!offered) return;
    let live = true;
    api<RoomDefaults>("GET", "/api/settings/defaults").then((d) => live && setDefaults(d)).catch(() => {});
    return () => {
      live = false;
    };
  }, [offered]);
  return { offered, defaults, setDefaults };
}
type NewChatDefaults = ReturnType<typeof useNewChatDefaults>;

function NewChatsToo({ member, s, too: { offered, defaults, setDefaults } }: { member: Member; s: AgentSettings; too: NewChatDefaults }) {
  const toast = useStore((st) => st.toast);
  const [busy, setBusy] = useState(false);
  if (!offered || !defaults) return null;
  const same = startsLikeThis(member, defaults.agent[member.provider]);
  const words = [s.words.answers, s.words.may].join(" · ");
  const save = async () => {
    setBusy(true);
    try {
      setDefaults(await api<RoomDefaults>("PATCH", `/api/settings/defaults/${member.provider}`, asDefaults(member)));
      toast("info", `Saved. New ${s.agentName} chats start with ${words}.`);
    } catch (e) {
      toast("error", e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="cs-newchats">
      {same ? (
        <p className="cs-note" role="status">New {s.agentName} chats start like this too.</p>
      ) : (
        <>
          <button type="button" className="btn small" disabled={busy} onClick={save}>
            {busy ? "Saving…" : "Use these for new chats too"}
          </button>
          <p className="cs-note">New {s.agentName} chats would start with {words}.</p>
        </>
      )}
    </div>
  );
}

/** The limits of the plan that pays for this agent's replies, as far as its account reports them. */
export function PlanLimits({ member }: { member: Member }) {
  const key = accountKey(member.provider, memberAccount(member));
  const usage = useStore((s) => s.usage[key]);
  // A service tells Crosstalk nothing about limits, so "Not checked yet" would never come true.
  const service = useStore((s) => s.accounts[key]?.kind === "endpoint");
  const windows = (usage?.windows ?? []).filter((w) => w.usedPercent !== null);
  if (service && !windows.length) return null;
  return (
    <>
      <div className="cs-part-title">
        Plan limits{usage?.plan ? <span className="muted"> · {usage.plan}</span> : null}
      </div>
      {windows.length ? windows.map((w) => <UsageLine key={w.label} w={w} />) : <p className="cs-note">{usage ? "No limits reported for this account." : "Not checked yet."}</p>}
    </>
  );
}

/** Answers with: the account, the model, how hard it thinks, and the model's own extras. */
function AnswersWith({ room, member, s, too }: { room: Room; member: Member; s: AgentSettings; too: NewChatDefaults }) {
  const accounts = useStore((st) => st.accounts);
  const list = Object.values(accounts).filter((a) => a.provider === member.provider);
  const [switching, setSwitching] = useState<string | null>(null);
  // The machine's accounts as they are now (one added or signed out since the app last heard).
  const refresh = useStore((st) => st.refreshAccounts);
  useEffect(() => {
    void refresh().catch(() => {});
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  // An effort saved for another model, which this one doesn't take: it would fail the next reply, so it's said and can be cleared.
  const stale = !!s.effort && !!s.current && !s.levels.includes(s.effort);
  const { agentName, catalog, current, actual } = s;
  // Where More models come from: the agent keeps them out of its usual list, or a model server lists more than were saved.
  const moreNote = s.endpoint ? `${s.endpoint} lists these too. They aren't saved with this account.` : `${agentName} keeps these out of its usual list.`;
  const next = switching ? list.find((a) => a.id === switching) : undefined;
  return (
    <>
      {list.length > 1 && (
        <Part title="Account">
          <AccountCards accounts={list} value={s.account} onChange={setSwitching} />
          <p className="cs-note">{whenWords("account", member, agentName)}</p>
        </Part>
      )}
      <Part title="Model">
        {/* A chat on a service of yours: its models are the service's, and this says which agent runs them. */}
        {s.endpoint && <p className="cs-note">{s.endpoint}'s models, run by {agentName}.</p>}
        {!catalog && <p className="cs-note">Asking {agentName} for its models…</p>}
        {catalog && !catalog.live && <p className="cs-note">{agentName} couldn't be asked for its models{catalog.error ? ` (${catalog.error})` : ""}.</p>}
        <ModelPicker models={s.models} current={current?.id ?? null} note={moreNote} onChoose={(id) => void s.chooseModel(id)} onType={(name) => void s.chooseModel(name)}>
          {actual && !current && <MenuItem on tone={s.gone ? "warn" : ""} title={actual} help={s.gone ? `${agentName} doesn't list this model now, so replies may fail. Pick one above.` : "Typed in by name."} onClick={() => {}} />}
        </ModelPicker>
      </Part>
      {current && (s.levels.length > 0 || current.defaultEffort || stale) && (
        <Part title="Effort">
          {s.levels.length > 0 ? (
            <EffortSteps levels={s.levels} value={s.effort} defaultLevel={current.defaultEffort} agentName={agentName} onChange={(v) => void s.setEffort(v)} />
          ) : (
            current.defaultEffort && <p className="cs-note">{effortName(current.defaultEffort)} (included in this model).</p>
          )}
          {stale && (
            <div className="cs-newchats">
              <button type="button" className="btn small" onClick={() => void s.setEffort("")}>
                Clear it
              </button>
              <p className="cs-note">The saved effort “{effortName(s.effort)}” is not one this model takes.</p>
            </div>
          )}
        </Part>
      )}
      {(s.fast || s.ultracodeOffered || s.longOffered) && (
        <Part title="Extras">
          {s.fast && <SwitchRow icon={<Zap size={16} className="ctl-fast" aria-hidden="true" />} title={s.fast.label === "Fast" ? "Fast mode" : s.fast.label} help={s.fast.description} checked={s.fastOn} onChange={(on) => s.setFast(on)} />}
          {s.ultracodeOffered && <SwitchRow icon={<Sparkles size={16} className="ctl-ultra" aria-hidden="true" />} title="Ultracode" help="Claude plans big tasks and runs several agents at once. Much faster on large work, and uses much more of your plan." checked={s.ultracode} onChange={(on) => s.setUltracode(on)} />}
          {s.longOffered && s.exact && (
            <SwitchRow
              title="Long context"
              help={`Remembers up to ${contextSize(s.exact.maxContextWindow!)} of the chat instead of ${contextSize(s.exact.contextWindow!)}, so it summarizes less often. Long chats use your plan faster.`}
              checked={s.long}
              onChange={(on) => s.setLong(on)}
            />
          )}
        </Part>
      )}
      <p className="cs-when">{whenWords("settings", member, agentName)}</p>
      <NewChatsToo member={member} s={s} too={too} />
      <div className="cs-usage">
        <ChatCostLine room={room} member={member} />
        <PlanLimits member={member} />
      </div>
      {switching && next && (
        <AskOnce title={`Switch to ${next.label}?`} confirmLabel="Switch account" onConfirm={() => s.switchAccount(switching)} onClose={() => setSwitching(null)}>
          {agentName} starts fresh on {next.label}: it forgets what was said so far, and its model and effort go back to that account's own. The messages here stay.
          {s.busy ? ` It happens once ${agentName} finishes this reply.` : ""}
        </AskOnce>
      )}
    </>
  );
}

/** May do: what the agent may do without asking, and what was always allowed along the way. */
function MayDo({ member, s, too }: { member: Member; s: AgentSettings; too: NewChatDefaults }) {
  const [full, setFull] = useState(false);
  const info = permissionInfo(member.provider, "full");
  const pick = (mode: PermissionMode) => (mode === "full" ? setFull(true) : void s.setPermission(mode));
  return (
    <>
      <PermissionCards provider={member.provider} value={member.permissionMode} onChange={pick} />
      <p className="cs-when">{whenWords("permissions", member, s.agentName)} This is access inside Crosstalk, separate from the machine's own privacy settings.</p>
      <AlwaysAllowedList member={member} agentName={s.agentName} />
      <NewChatsToo member={member} s={s} too={too} />
      {full && (
        <AskOnce title={`Give ${s.agentName} full access?`} confirmLabel="Give full access" danger onConfirm={() => s.setPermission("full")} onClose={() => setFull(false)}>
          {info.help}
        </AskOnce>
      )}
    </>
  );
}

/**
 * Helpers: who does the extra work the agent hands out. Its own helpers (with the model picked for them), or another
 * account of this machine ("Helpers run on", HelpersOn.tsx).
 */
function Helpers({ member, s }: { member: Member; s: AgentSettings }) {
  // A save that failed: what the control showed while it was on its way goes back to what the chat has.
  const [unsaved, setUnsaved] = useState(0);
  return (
    <HelpersOnControl
      key={unsaved}
      value={helpersOf(member.config)}
      own={{ provider: member.provider, account: s.account }}
      onChange={async (v) => {
        if (!(await s.setConfig("helpersOn", cleanHelpersOn(v)))) setUnsaved((n) => n + 1);
      }}
      ownModel={
        s.helpersOffered ? (
          <label className="field">
            <span>Their model</span>
            <HelperSelect models={s.models} own={s.current?.resolvedModel ?? s.current?.id ?? ""} value={s.helperId} onChange={(v) => void s.setHelperModel(v)} />
            <span className="help">{helperHelp(member.provider)}</span>
          </label>
        ) : null
      }
    />
  );
}

/** A group chat's own section: how its agents work together (GroupHow, the same choice New group chat has), saved as it's made. */
function WorkingTogether({ room, members }: { room: Room; members: Member[] }) {
  const toast = useStore((s) => s.toast);
  // What was just picked shows at once, while the save is on its way; what the chat says wins as soon as it says
  // something, and a save that failed goes back to it.
  const [picked, setPicked] = useState<Partial<Room>>({});
  const said = JSON.stringify([room.mode, room.leadMemberId, room.maxHops, room.parallel]);
  useEffect(() => setPicked({}), [said]);
  const now = { ...room, ...picked };
  const answers = groupAnswers(now.mode);
  const save = async (patch: Partial<Room>) => {
    setPicked((p) => ({ ...p, ...patch }));
    try {
      await api("PATCH", `/api/rooms/${room.id}`, patch);
    } catch (e) {
      setPicked({});
      toast("error", e instanceof Error ? e.message : String(e));
    }
  };
  return (
    <GroupHow
      answers={answers}
      // A review counts a round as the lead's work and its review (Room.maxHops): the rounds it has go with the choice.
      onAnswers={(a) => void save({ mode: groupMode(a), ...(a === "review" ? { maxHops: hopsOf(roundsOf(now.maxHops)) } : {}) })}
      leads={members.map((m) => ({ id: m.id, label: `@${m.handle} (${PROVIDER_INFO[m.provider]?.name ?? m.provider})`, handle: m.handle }))}
      lead={now.leadMemberId ?? members[0]?.id ?? ""}
      onLead={(id) => void save({ leadMemberId: id })}
      rounds={roundsOf(now.maxHops)}
      onRounds={(n) => void save({ maxHops: hopsOf(n) })}
      parallel={now.parallel}
      onParallel={(on) => void save({ parallel: on })}
      note={answers === "review" && members.length < 2 ? "A review needs two agents. Add another one below." : null}
    />
  );
}

/** Sizes a chat can summarize its earlier messages at by itself: the agent's own default, or a size picked to save usage. */
const SUMMARIZE_AT = [100_000, 200_000, 400_000, 600_000, 800_000];
const toneFor = (pct: number) => (pct >= 90 ? "full" : pct >= 70 ? "warn" : "");

/**
 * Memory: how much of the chat the model still holds, summarizing the earlier messages (now, or by itself at a size),
 * and starting fresh. `onFresh` asks before it does.
 */
export function ChatMemory({ room, member, model, onCompactAt, onFresh }: { room: Room; member: Member; model: ModelOption | undefined; onCompactAt: (v: string) => void; onFresh?: () => void }) {
  const toast = useStore((s) => s.toast);
  const ctx = useChatContext(room, member, model);
  const agent = PROVIDER_INFO[member.provider].name;
  const busy = isBusy(member);
  const compactAt = typeof member.config?.autoCompact === "number" ? member.config.autoCompact : null;
  // Sizes below where the agent summarizes by itself (else below what the chat holds).
  const limit = ctx.size?.compactAt ?? ctx.window;
  const choices = SUMMARIZE_AT.filter((n) => !limit || n < limit);
  // What the default really is. Larger sizes stay offered on a service: the chat can pick later than its default.
  // An older machine summarizes a service's chat at three quarters of what it holds, which it doesn't say to the app.
  const olderHub = useStore((s) => olderThan(s.hub?.version, "0.6.6"));
  const defaultAt = ctx.size?.compactAt ?? (olderHub ? null : serviceCompactPoint(member.provider, ctx.window));
  const summarizeNow = async () => {
    try {
      await api("POST", `/api/rooms/${room.id}/messages`, { text: "/compact" });
      toast("info", `${agent} is summarizing the earlier messages.`);
    } catch (e) {
      toast("error", e instanceof Error ? e.message : String(e));
    }
  };
  const { pct } = memoryWords(ctx.tokens, ctx.window);
  // Codex keeps part of what the model holds for its instructions and the reply: the conversation fills the rest.
  const reserve = ctx.size && ctx.size.usable < ctx.size.window ? Math.round(100 - (ctx.size.usable / ctx.size.window) * 100) : 0;
  const group = !!room.chat?.group;
  return (
    <>
      {ctx.tokens !== null ? (
        <div className="usage-line">
          <span className="usage-label">
            {formatTokens(ctx.tokens)}
            {ctx.window ? ` of ${contextSize(ctx.window)}` : ""}
          </span>
          {pct !== null && (
            <>
              <div className={`meter ${toneFor(pct)}`}>
                <i style={{ ["--fill" as string]: pct / 100 }} />
              </div>
              <span className="usage-pct">{pct}%</span>
            </>
          )}
        </div>
      ) : (
        <p className="cs-note">
          {ctx.window ? `${model?.label ?? "The model"} remembers up to ${contextSize(ctx.window)} of a chat. ` : ""}How full that is shows after {agent}'s next reply.
        </p>
      )}
      {model && ctx.size && (reserve > 0 || ctx.size.long) && (
        <p className="cs-note">
          {model.label} holds {contextSize(ctx.size.window)}
          {ctx.size.long ? " with long context" : ""}
          {reserve > 0 ? `; ${agent} keeps ${reserve}% of it for its instructions and the reply.` : "."}
        </p>
      )}
      {/* A group chat's messages go to who they're for: "/compact" there would be a message, not the agent's command. */}
      {pct !== null && pct >= 80 && !group && <p className="cs-note">Nearly full. Summarize now to make room.</p>}
      {!group && (
        <button className="btn block" disabled={busy} onClick={summarizeNow} title={busy ? `Available when ${agent} isn't working` : undefined}>
          Summarize now
        </button>
      )}
      {!group && busy && <p className="cs-note">Available once {agent} finishes this reply.</p>}
      <label className="field cs-summarize">
        <span>Summarize by itself at</span>
        <select className="select" aria-label="Summarize by itself at" value={compactAt ?? ""} onChange={(e) => onCompactAt(e.target.value)}>
          <option value="">
            {agent}'s default ({defaultAt ? contextSize(defaultAt) : "near full"})
          </option>
          {[...new Set([...choices, ...(compactAt ? [compactAt] : [])])]
            .sort((a, b) => a - b)
            .map((n) => (
              <option key={n} value={n}>
                {formatTokens(n)} tokens
              </option>
            ))}
        </select>
        <span className="help">Summarizing shortens the earlier messages so each reply reads less. A smaller size uses less of your plan; {agent} remembers less detail.</span>
      </label>
      {onFresh && (
        <div className="cs-fresh">
          <button className="btn" onClick={onFresh}>
            <RotateCcw size={14} aria-hidden="true" /> Start fresh
          </button>
          <p className="cs-note">{agent} forgets what was said so far and starts over. The messages here stay.</p>
        </div>
      )}
    </>
  );
}

/** Asked once before an agent starts fresh: its messages stay. */
function StartFresh({ room, member, onClose, onDone }: { room: Room; member: Member; onClose: () => void; /** It was started fresh: back to the chat. */ onDone: () => void }) {
  const toast = useStore((s) => s.toast);
  const name = PROVIDER_INFO[member.provider].name;
  const who = room.chat?.group ? `@${member.handle}` : name;
  // A message of yours the agent hasn't read yet (on machines that say what it has read): starting fresh leaves it to be
  // asked for, with Answer now under it, or Try again on the reply that failed on it.
  const waiting = useStore((s): "Answer now" | "Try again" | null => {
    if (member.readSeq === undefined || room.chat?.group) return null;
    const list = s.roomData[room.id]?.messages ?? [];
    const i = list.findLastIndex((m) => m.authorKind === "human" && !m.via);
    const seq = i >= 0 ? list[i].seq : undefined;
    if (typeof seq !== "number" || seq <= member.readSeq) return null;
    return list.slice(i + 1).some(isReply) || s.hub?.flowsIn ? "Try again" : "Answer now";
  });
  return (
    <AskOnce
      title={`Start ${who} fresh?`}
      confirmLabel="Start fresh"
      onConfirm={async () => {
        try {
          await api("POST", `/api/members/${member.id}/reset`);
          toast("info", `${who} starts fresh with its next reply.`);
          onDone();
        } catch (e) {
          toast("error", e instanceof Error ? e.message : String(e));
        }
      }}
      onClose={onClose}
    >
      {who} forgets what was said so far and starts over. The messages here stay.
      {isBusy(member) && ` Starting fresh stops ${who} now.`}
      {waiting === "Answer now" && " A message it hasn't read yet isn't answered until you tap Answer now under it."}
      {waiting === "Try again" && " A message it hasn't read yet isn't answered until you tap Try again."}
    </AskOnce>
  );
}

/** A group chat's agent: its @name, what it should focus on, leading, and leaving the chat. */
function NameAndRole({ room, member, lead }: { room: Room; member: Member; lead: boolean }) {
  const toast = useStore((s) => s.toast);
  const [handle, setHandle] = useState(member.handle);
  const [role, setRole] = useState(member.role ?? "");
  const [busy, setBusy] = useState(false);
  const [removing, setRemoving] = useState(false);
  const handleNow = handle.trim() ? slugHandle(handle.trim()) : member.handle;
  const dirty = handleNow !== member.handle || role !== (member.role ?? "");
  const run = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    try {
      await fn();
    } catch (e) {
      toast("error", e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      <label className="field">
        <span>Name</span>
        <input className="input" aria-label="Name" value={handle} onChange={(e) => setHandle(e.target.value.replace(/^@/, ""))} autoCapitalize="off" autoCorrect="off" spellCheck={false} />
        <span className="help">Others mention it as @{handleNow}.</span>
      </label>
      {/* Not a <label>: tapping "Role" would click the first preset and overwrite what's written. */}
      <div className="field">
        <span>Role</span>
        <div className="row wrap" style={{ gap: 6 }}>
          {ROLE_PRESETS.map((r) => (
            <button key={r.label} type="button" className="btn small" onClick={() => setRole(r.text)}>
              {r.label}
            </button>
          ))}
        </div>
        <textarea className="textarea" placeholder="What should this agent focus on? (optional)" value={role} onChange={(e) => setRole(e.target.value)} aria-label="Role instructions" />
      </div>
      {dirty && (
        <button className="btn primary" disabled={busy} onClick={() => run(async () => { const saved = await api<Member>("PATCH", `/api/members/${member.id}`, { handle: handle.trim() || member.handle, role }); setHandle(saved.handle); toast("info", `Saved. It's @${saved.handle} from its next reply.`); })}>
          {busy ? "Saving…" : "Save name and role"}
        </button>
      )}
      <div className="cs-actions">
        <button className="btn small" disabled={busy || lead} onClick={() => run(() => api("PATCH", `/api/rooms/${room.id}`, { leadMemberId: member.id }))}>
          {lead ? "Leads this chat" : "Make lead"}
        </button>
        <button className="btn small danger" disabled={busy} onClick={() => setRemoving(true)}>
          Remove from chat
        </button>
      </div>
      {removing && (
        <TwoStepDialog
          title={`Remove @${member.handle} from this chat?`}
          icon={<Trash2 size={18} />}
          detail={`Its messages stay. It stops answering here${isBusy(member) ? ", and what it's doing now is stopped" : ""}.`}
          sure={`@${member.handle} forgets what it knew of this chat.`}
          confirmLabel="Yes, remove"
          workingLabel="Removing…"
          agentName={`@${member.handle}`}
          onConfirm={() => api("DELETE", `/api/members/${member.id}`)}
          onClose={() => setRemoving(false)}
        />
      )}
    </>
  );
}

/** One agent's own sections: Answers with, May do, Helpers, Memory (and, in a group chat, its name and role). */
function AgentSections({ room, member, folds, group, lead = false, onClose }: { room: Room; member: Member; folds: Folds; group: boolean; lead?: boolean; onClose: () => void }) {
  const s = useAgentSettings(room, member);
  // What new chats with this agent start with, read once for both sections that offer "Use these for new chats too".
  const too = useNewChatDefaults(member);
  const ctx = useChatContext(room, member, s.exact);
  const [fresh, setFresh] = useState(false);
  const held = heldLine(member, s.agentName);
  const accountLabel = useStore((st) => (s.account === "default" ? null : st.accounts[accountKey(member.provider, s.account)]?.label ?? null));
  // Another account does its helper work ("Helpers run on"): its name, for the closed row.
  const helpersOn = helpersOf(member.config);
  const helpersName = useStore((st) => (helpersOn ? helpersOnLabel(helpersOn, Object.values(st.accounts)) : null));
  const summary: Record<SectionId, ReactNode> = {
    answers: [accountLabel, s.words.answers, s.fastOn ? "Fast" : null, s.ultracode ? "Ultracode" : null].filter(Boolean).join(" · "),
    may: <span className={s.words.danger ? "cs-danger" : undefined}>{s.words.may}</span>,
    helpers: helpersName ? `Run on ${helpersName}` : s.helper ? `${s.agentName}'s own, on ${s.helper.label}` : `${s.agentName}'s own, on the same model`,
    memory: memoryWords(ctx.tokens, ctx.window).words,
    agent: [`@${member.handle}`, lead ? "leads" : null, member.role ? "has a role" : null].filter(Boolean).join(" · "),
    group: "",
    chat: "",
  };
  const body = (id: SectionId) => {
    switch (id) {
      case "answers":
        return <AnswersWith room={room} member={member} s={s} too={too} />;
      case "may":
        return <MayDo member={member} s={s} too={too} />;
      case "helpers":
        return <Helpers member={member} s={s} />;
      case "memory":
        return <ChatMemory room={room} member={member} model={s.exact} onCompactAt={(v) => void s.setCompactAt(v)} onFresh={() => setFresh(true)} />;
      case "agent":
        return <NameAndRole room={room} member={member} lead={lead} />;
      default:
        return null;
    }
  };
  return (
    <>
      {held && (
        <p className="cs-held" role="status">
          {held}
        </p>
      )}
      {agentSections(member.provider, group).map((id) => (
        <Fold key={id} at={foldKey(id, member.id)} title={SECTION_TITLES[id]} summary={summary[id]} icon={ICONS[id]} folds={folds} level={group ? 3 : 2}>
          {body(id)}
        </Fold>
      ))}
      {fresh && <StartFresh room={room} member={member} onClose={() => setFresh(false)} onDone={onClose} />}
    </>
  );
}

/** A group chat's agent as a row that opens into its own sections. */
function AgentBlock({ room, member, folds, lead, onClose }: { room: Room; member: Member; folds: Folds; lead: boolean; onClose: () => void }) {
  const at = `agent:${member.id}`;
  const id = useId();
  const open = folds.open(at);
  const models = useAgentModels(member);
  const accountLabel = useStore((st) => (memberAccount(member) === "default" ? null : st.accounts[accountKey(member.provider, memberAccount(member))]?.label ?? null));
  return (
    <section className={`cs-fold cs-agent${open ? " open" : ""}`} aria-label={`@${member.handle}`} data-fold={at}>
      <button type="button" className="cs-fold-head" aria-expanded={open} aria-controls={id} onClick={() => folds.toggle(at)}>
        <span className="cs-fold-icon">
          <MemberAvatar member={member} size="sm" showState />
        </span>
        <span className="cs-fold-text">
          <span className="cs-fold-title">
            @{member.handle}
            {lead && <span className="pill">Lead</span>}
          </span>
          <span className="cs-fold-sum">{agentLine(member, models, accountLabel)}</span>
        </span>
        <ChevronDown size={17} className="cs-fold-chevron" aria-hidden="true" />
      </button>
      {open && (
        <div className="cs-fold-body cs-agent-body" id={id}>
          <AgentSections room={room} member={member} folds={folds} group lead={lead} onClose={onClose} />
        </div>
      )}
    </section>
  );
}

/** The models an agent's account lists, for naming its model in a closed row. */
function useAgentModels(member: Member): ModelOption[] {
  return useCatalog(member.provider, memberAccount(member)).catalog?.models ?? [];
}

/** This chat: its name, pinning, who can reach it, its folder, and duplicating, exporting or deleting it. */
function ThisChat({ room, members, machine, onClose, onDuplicate }: { room: Room; members: Member[]; machine: string | null; onClose: () => void; onDuplicate: () => void }) {
  const toast = useStore((s) => s.toast);
  const openAgent = useStore((s) => s.openAgent);
  const setView = useStore((s) => s.setView);
  const accounts = useStore((s) => s.accounts);
  const group = !!room.chat?.group;
  const member = members[0] as Member | undefined;
  const provider = (room.chat?.provider ?? member?.provider ?? "claude") as ChatProvider;
  const info = PROVIDER_INFO[provider];
  const identity = chatIdentity(room, group ? undefined : member, accounts);
  // The name is measured from what the box opened with: another device's rename meanwhile stays unless one is typed here.
  const [nameAtOpen, setNameAtOpen] = useState(() => room.name);
  const [name, setName] = useState(nameAtOpen);
  const said = nameEdit(name, nameAtOpen, room.name);
  const nameId = useId();
  const machines = useMachines((m) => m.list);
  const active = useStore((s) => s.active);
  const [busy, setBusy] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const working = members.some(isBusy);
  const act = async (fn: () => Promise<unknown>): Promise<boolean> => {
    setBusy(true);
    try {
      await fn();
      return true;
    } catch (e) {
      toast("error", e instanceof Error ? e.message : String(e));
      return false;
    } finally {
      setBusy(false);
    }
  };
  const rename = () =>
    act(async () => {
      if (said.send) await api("PATCH", `/api/rooms/${room.id}`, { name: said.send });
      setNameAtOpen(name.trim());
      setName(name.trim());
    });
  // Pinned to the top of the chat list on every device: kept by the chat's machine. One on an older Crosstalk can't, and says so.
  const pin = async (pinned: boolean): Promise<boolean> => {
    setBusy(true);
    try {
      const here = machines.find((m) => m.key === active);
      if (!here) throw new Error("This chat's machine isn't connected yet. Try again in a moment.");
      await pinChat(here, room.id, pinned, machines);
      return true;
    } catch (e) {
      pinFailed(e);
      return false;
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      <div className="field">
        <label htmlFor={`${nameId}-box`}>
          <span>Name</span>
        </label>
        <div className="cs-name">
          <input id={`${nameId}-box`} className="input" value={name} maxLength={80} onChange={(e) => setName(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter" && said.changed && !e.nativeEvent.isComposing) { e.preventDefault(); void rename(); } }} aria-invalid={!name.trim()} aria-describedby={!name.trim() ? nameId : undefined} enterKeyHint="done" />
          {said.changed && (
            <button className="btn primary" disabled={busy} onClick={rename}>
              Save name
            </button>
          )}
        </div>
        {!name.trim() && (
          <span className="help cs-problem" id={nameId}>
            A chat needs a name. Type one to rename it.
          </span>
        )}
        {identity.service && !group && (
          <span className="help">
            Runs on {identity.name}, {identityWhere(identity, machine)} · driven by {info.name}
            {isServiceOnlyAgent(provider) ? "." : ", which its model and helpers follow."}
          </span>
        )}
      </div>
      <SwitchRow title="Pinned" help="Stays at the top of your chat list, on every device." checked={isPinned(room)} onChange={pin} disabled={busy} />
      <SwitchRow
        title={group ? "Other chats' agents can read this chat" : "Other chats' agents can reach this chat"}
        help={
          group
            ? `When "Let agents reach your other chats" is on (${settingsPath("together")}). They can't message a group chat. Off keeps it private, and its agents don't reach other chats either.`
            : `They can find, read and message it, when "Let agents reach your other chats" is on (${settingsPath("together")}). Off keeps it private, and its own agent doesn't reach other chats either.`
        }
        checked={!room.privateFromAgents}
        onChange={(on) => act(() => api("PATCH", `/api/rooms/${room.id}`, { privateFromAgents: !on }))}
        disabled={busy}
      />
      <div className="field">
        <span>Folder</span>
        <span className="mono small" style={{ overflowWrap: "anywhere" }}>
          {room.cwd}
          {machine && <span className="folder-machine"> on {machine}</span>}
        </span>
        {group ? <span className="help">They all work in this folder.</span> : room.chat && room.chat.origin !== "web" && <span className="help">Continues a chat from {ORIGIN[room.chat.origin] ?? "another app"}.</span>}
      </div>
      <div className="cs-actions">
        <button className="btn small" disabled={busy} onClick={() => { onClose(); onDuplicate(); }}>
          <Copy size={13} /> Duplicate chat…
        </button>
        <ExportMarkdownButton room={room} disabled={busy} />
        <button className="btn small danger" disabled={busy} onClick={() => setDeleting(true)}>
          Delete chat
        </button>
      </div>
      {deleting && (
        // Its messages go: asked twice.
        <TwoStepDialog
          title="Delete this chat?"
          icon={<Trash2 size={18} />}
          detail={["Its messages are removed from Crosstalk.", !group && room.chat && room.chat.origin !== "web" ? `It stays in ${ORIGIN[room.chat.origin] ?? "its app"}.` : null, "Files in its folder stay.", working ? (group ? "Deleting stops the agents." : `Deleting stops ${info.name}.`) : null].filter(Boolean).join(" ")}
          sure="This can't be undone."
          confirmLabel="Yes, delete"
          workingLabel="Deleting…"
          agentName={group ? "the agents" : info.name}
          group={group}
          onConfirm={async () => {
            await deleteRoomHere(room.id);
            onClose();
            // A group chat, Crosstalk's own agent and OpenCode have no screen of their own to go back to.
            if (group || isServiceOnlyAgent(provider)) setView("rooms");
            else openAgent(provider);
          }}
          onClose={() => setDeleting(false)}
        />
      )}
    </>
  );
}

/**
 * A chat's settings, all of them, in one sheet: a row per section that says what's in force and opens in place.
 * One agent: Answers with, May do, Helpers, Memory, This chat. A group chat: how its agents work together, a block per
 * agent with those same sections, then This chat. Every choice is saved as it's made, and each says when it applies.
 * `at`: the section it opens on (a chip under the message box names one); without it, every section starts closed.
 */
export function ChatSettingsSheet({ room, members, machine, at, onClose, onDuplicate }: { room: Room; members: Member[]; machine: string | null; at?: SheetAt | null; onClose: () => void; onDuplicate: () => void }) {
  const group = !!room.chat?.group;
  const accounts = useStore((s) => s.accounts);
  const member = (group ? turnOrder(room, members)[0] : members[0]) as Member | undefined;
  const [open, setOpen] = useState<string[]>(() => openAt(at, group));
  const [adding, setAdding] = useState(false);
  const folds: Folds = { open: (key) => open.includes(key), toggle: (key) => setOpen((now) => (now.includes(key) ? now.filter((k) => k !== key) : [...now, key])) };
  const body = useRef<HTMLDivElement>(null);
  // Opened on a section: that one is at the top of the sheet, so its choices are the next thing under the thumb.
  useEffect(() => {
    const want = openAt(at, group).at(-1);
    if (want) body.current?.querySelector(`[data-fold="${CSS.escape(want)}"]`)?.scrollIntoView({ block: "start" });
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  const leadId = room.leadMemberId ?? members[0]?.id;
  const lead = members.find((m) => m.id === leadId);
  return (
    <Dialog title="Chat settings" icon={group ? <GroupAvatar members={members} size="sm" /> : member ? <ChatAvatar identity={chatIdentity(room, member, accounts)} /> : undefined} onClose={onClose}>
      <div className="cs-sheet" ref={body}>
        {group ? (
          <>
            <Fold at="group" title={SECTION_TITLES.group} summary={lead ? [ANSWER_OPTIONS.find((o) => o.id === groupAnswers(room.mode))?.label, moreLine({ lead: lead.handle, answers: groupAnswers(room.mode), rounds: roundsOf(room.maxHops), parallel: room.parallel })].filter(Boolean).join(" · ") : ""} icon={ICONS.group} folds={folds}>
              <WorkingTogether room={room} members={members} />
            </Fold>
            {members.map((m) => (
              <AgentBlock key={m.id} room={room} member={m} folds={folds} lead={m.id === leadId} onClose={onClose} />
            ))}
            <button className="btn small cs-add" onClick={() => setAdding(true)}>
              <Plus size={14} /> Add an agent
            </button>
          </>
        ) : (
          member && <AgentSections room={room} member={member} folds={folds} group={false} onClose={onClose} />
        )}
        <Fold at="chat" title={SECTION_TITLES.chat} summary={room.name} icon={ICONS.chat} folds={folds}>
          <ThisChat room={room} members={members} machine={machine} onClose={onClose} onDuplicate={onDuplicate} />
        </Fold>
      </div>
      {adding && <AgentDialog room={room} member={null} onClose={() => setAdding(false)} />}
    </Dialog>
  );
}
