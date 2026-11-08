import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { ChevronDown, Shield, ShieldAlert, ShieldCheck, Sparkles, Users, Zap } from "lucide-react";
import { chatContextSize, EFFORT_LABELS, PERMISSION_MODES, PROVIDER_INFO, permissionInfo, serviceCompactPoint, turnOrder, wantsLongContext, type ChatContextSize, type ChatProvider, type Member, type ModelOption, type PermissionMode, type Room } from "@crosstalk/shared";
import { olderThan } from "../version";
import { api } from "../api";
import { accountKey, memberAccount } from "../accounts";
import { isPoolAccount } from "../chatIdentity";
import { showInSettings } from "../navigation";
import { poolModelNote } from "../poolChat";
import { HELPER_PROVIDERS, HelperSelect, helperHelp } from "./AgentOptions";
import { MenuItem, ModelChoices } from "./ModelChoices";
import { contextSize, sameModelId } from "../models";
import { useStore } from "../store";
import { useCatalog } from "../useCatalog";
import { formatTokens, MemberAvatar, Switch } from "../ui";
import { UsageLine } from "./HomeScreen";
import { ChatCostLine } from "./ChatCost";
import { leave } from "../motion";

/** Settings → Model pool, from a chat on the pool: the one place its model is chosen and the pool is started. */
function openModelPool() {
  showInSettings("model-pool");
  useStore.getState().setView("settings");
}

/** Effort as the bar shows it: one short word. */
const EFFORT_SHORT: Record<string, string> = { ...EFFORT_LABELS, xhigh: "Extra" };
const effortWord = (e: string) => EFFORT_SHORT[e] ?? e;

type Menu = "member" | "permissions" | "model" | "effort" | "context" | null;

/**
 * The row under a chat's message box: permissions on the left; model, effort and context on the right. In a group chat
 * (`members`) it's for one of its agents at a time, picked at its start (the lead to begin with).
 */
export function ChatControls({ room, member: only, members }: { room: Room; member: Member; members?: Member[] }) {
  const toast = useStore((s) => s.toast);
  const [pickedId, setPickedId] = useState<string | null>(null);
  const member = members?.find((m) => m.id === pickedId) ?? (members ? turnOrder(room, members)[0] : undefined) ?? only;
  const account = memberAccount(member);
  // Model lists come from each agent's CLI, through the hub, which says when one changes.
  const { catalog } = useCatalog(member.provider, account);
  const signIn = useStore((s) => s.accounts[accountKey(member.provider, account)]);
  const endpoint = signIn?.kind === "endpoint" ? signIn.label : null;
  // A chat on the model pool: a pool serves one model at a time, so its menu says that and where the model is changed,
  // instead of offering a list it can't run (poolChat.ts).
  const poolOffer = useStore((s) => s.poolOffer);
  const pool = isPoolAccount(signIn, poolOffer) ? poolOffer : null;
  const [menu, setMenu] = useState<Menu>(null);
  const box = useRef<HTMLDivElement>(null);
  // A narrow row (a small phone, or a big text size): permissions show as an icon, so the model's name has room.
  const [narrow, setNarrow] = useState(false);
  useEffect(() => {
    const el = box.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(() => setNarrow(el.clientWidth < 290));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // Tapping anywhere else, or Escape, closes the open menu.
  useEffect(() => {
    if (!menu) return;
    const down = (e: PointerEvent) => {
      if (!box.current?.contains(e.target as Node)) setMenu(null);
    };
    const key = (e: KeyboardEvent) => e.key === "Escape" && setMenu(null);
    document.addEventListener("pointerdown", down);
    document.addEventListener("keydown", key);
    return () => {
      document.removeEventListener("pointerdown", down);
      document.removeEventListener("keydown", key);
    };
  }, [menu]);

  const actual = member.resolvedModel ?? member.model;
  // A pool chat is offered the model the pool runs, and the one this chat still names if it differs — nothing else: the
  // pool's server serves one model at a time, so its other names could never answer here.
  const listed = catalog?.models ?? [];
  const models = pool ? listed.filter((m) => m.id === pool.model || (!!actual && (m.id === actual || m.resolvedModel === actual))) : listed;
  const def = models.find((m) => m.isDefault);
  // What the context meter reads sizes from: only the list's entry for exactly this model.
  const exact = actual ? models.find((m) => m.id === actual || m.resolvedModel === actual) : def;
  // "claude-opus-5-5[1m]" is Opus 5.5 run another way: the same entry for its name and effort levels (not its size).
  const current = exact ?? (actual ? models.find((m) => sameModelId(m.resolvedModel ?? m.id, actual) || sameModelId(m.id, actual)) : undefined);
  // The agent listed the chat's model before, and doesn't now.
  const gone = !!actual && !current && !!catalog?.live && !!catalog.gone?.some((g) => sameModelId(g, actual));
  const effort = typeof member.config?.effort === "string" ? member.config.effort : "";
  const levels = current?.efforts ?? [];
  const shownEffort = effort && levels.includes(effort) ? effort : current?.defaultEffort ?? "";
  const perm = permissionInfo(member.provider, member.permissionMode);
  // Claude Code's Ultracode is a separate switch (Codex's equivalent is its Ultra effort level, already on the slider).
  const ultracodeOffered = member.provider === "claude" && levels.length > 0;
  const ultracode = ultracodeOffered && member.config?.ultracode === true;
  // The faster (pricier) way to run this model, when it has one: Claude Code's fast mode, Codex's Fast tier.
  const fast = current?.fast ?? null;
  const fastOn = !!fast && member.config?.fast === true;
  // Helper agents (Claude Code's subagents and workflows, Codex's spawned agents) use the chat's model unless one is
  // picked for them here or in the chat's settings.
  const helpersOffered = HELPER_PROVIDERS.includes(member.provider) && models.length > 0;
  const helperId = typeof member.config?.helperModel === "string" ? member.config.helperModel : "";
  const helper = helperId ? models.find((m) => m.id === helperId || m.resolvedModel === helperId) ?? { id: helperId, label: helperId } : null;

  const patch = async (body: Partial<Member>) => {
    try {
      await api("PATCH", `/api/members/${member.id}`, body);
    } catch (e) {
      toast("error", e instanceof Error ? e.message : String(e));
    }
  };
  const toggle = (m: Exclude<Menu, null>) => setMenu((cur) => (cur === m ? null : m));

  const chooseModel = (id: string) => {
    setMenu(null);
    const next = models.find((m) => m.id === id);
    // What the chat is saved as running: the concrete model behind the agent's own id, where it says one.
    const saved = next?.resolvedModel ?? id;
    const config = { ...member.config };
    // A level the new model doesn't take would fail the next turn.
    if (typeof config.effort === "string" && !next?.efforts.includes(config.effort)) delete config.effort;
    // Helpers on the chat's own model again need no separate pick. A helper pick is saved as the concrete model
    // (HelperSelect), the menu's entry is the agent's own id: the same model by either name counts.
    if (config.helperModel === id || config.helperModel === saved) delete config.helperModel;
    // Long context goes with a model that has it.
    if (config.longContext && !(next?.maxContextWindow && next.contextWindow && next.maxContextWindow > next.contextWindow)) delete config.longContext;
    fitCompaction(config, chatContextSize(next, member.provider === "codex" && wantsLongContext(config)));
    void patch({ model: saved, config });
  };
  const agentName = PROVIDER_INFO[member.provider].name;
  // Where More models come from: the agent keeps them out of its usual list, or a model server lists more than were saved.
  const moreNote = endpoint ? `${endpoint} lists these too. They aren't saved with this account.` : `${agentName} keeps these out of its usual list.`;

  return (
    <div className={`chat-controls ${narrow ? "narrow" : ""}`} ref={box}>
      {members && (
        <button className="ctl ctl-member" onClick={() => toggle("member")} aria-expanded={menu === "member"} aria-label={`Settings for @${member.handle}. Pick another agent`} title="Which agent these are for">
          <MemberAvatar member={member} size="sm" />
          <span className="ellipsis">@{member.handle}</span>
          <ChevronDown size={13} aria-hidden="true" />
        </button>
      )}
      <button className={`ctl ${perm.tone === "red" ? "danger" : ""}`} onClick={() => toggle("permissions")} aria-expanded={menu === "permissions"} aria-label={`Permissions: ${perm.short}`} title={`${perm.short}: what it may do without asking`}>
        {narrow ? perm.tone === "red" ? <ShieldAlert size={15} aria-hidden="true" /> : perm.tone === "green" ? <ShieldCheck size={15} aria-hidden="true" /> : <Shield size={15} aria-hidden="true" /> : perm.short}
        <ChevronDown size={13} aria-hidden="true" />
      </button>
      <span className="ctl-spacer" />
      <button className="ctl ctl-model" onClick={() => toggle("model")} aria-expanded={menu === "model"} title="Model">
        {fastOn && <Zap size={13} className="ctl-fast" aria-label="Fast mode" />}
        {helper && <Users size={13} className="ctl-helpers" aria-label={`Helper agents use ${helper.label}`} />}
        <span className="ellipsis">{current?.label ?? actual ?? "Default model"}</span>
      </button>
      {levels.length > 0 && (
        <button className="ctl" onClick={() => toggle("effort")} aria-expanded={menu === "effort"} title="Effort">
          {shownEffort ? effortWord(shownEffort) : "Default"}
          {ultracode && (narrow ? <Sparkles size={13} className="ctl-ultra" aria-label="Ultracode" /> : <span className="ctl-ultra">· Ultracode</span>)}
        </button>
      )}
      <ContextRingButton room={room} member={member} model={exact} open={menu === "context"} onClick={() => toggle("context")} />

      {menu === "member" && members && (
        <Pop side="left" title="Settings for">
          {members.map((m) => (
            <MenuItem
              key={m.id}
              on={m.id === member.id}
              title={`@${m.handle}`}
              help={[PROVIDER_INFO[m.provider]?.name ?? m.provider, m.resolvedModel ?? m.model ?? "Default model", typeof m.config?.effort === "string" && m.config.effort ? `${effortWord(m.config.effort)} effort` : null].filter(Boolean).join(" · ")}
              onClick={() => {
                setPickedId(m.id);
                setMenu(null);
              }}
            />
          ))}
        </Pop>
      )}
      {menu === "permissions" && (
        <Pop side="left" title="Permissions">
          {PERMISSION_MODES.map((m) => {
            const info = permissionInfo(member.provider, m.id);
            return (
              <MenuItem
                key={m.id}
                on={member.permissionMode === m.id}
                tone={info.tone === "red" ? "danger" : ""}
                title={info.short}
                help={info.help}
                onClick={() => {
                  setMenu(null);
                  if (m.id === "full" && !confirm(`${info.help}\n\nGive ${PROVIDER_INFO[member.provider].name} full access?`)) return;
                  void patch({ permissionMode: m.id as PermissionMode });
                }}
              />
            );
          })}
        </Pop>
      )}
      {menu === "model" && (
        <Pop side="right" title="Model">
          {fast && (
            <div className="fast-row">
              <Zap size={16} className="ctl-fast" aria-hidden="true" />
              <div style={{ flex: 1 }}>
                <div className="pop-item-title">{fast.label === "Fast" ? "Fast mode" : fast.label}</div>
                {fast.description && <div className="pop-item-help">{fast.description}</div>}
              </div>
              <Switch
                checked={fastOn}
                label="Fast mode"
                onChange={(on) => {
                  const config = { ...member.config };
                  if (on) config.fast = true;
                  else delete config.fast;
                  void patch({ config });
                }}
              />
            </div>
          )}
          {/* A chat on a service of yours: its models are the service's, and this says which agent runs them. */}
          {pool ? (
            <p className="pop-note">{poolModelNote(pool, member.provider as ChatProvider)}</p>
          ) : (
            <>
              {endpoint && <p className="pop-note">{endpoint}'s models, run by {agentName}.</p>}
              {!catalog && <p className="pop-note">Asking {PROVIDER_INFO[member.provider].name} for its models…</p>}
              {catalog && !catalog.live && <p className="pop-note">{PROVIDER_INFO[member.provider].name} couldn't be asked for its models{catalog.error ? ` (${catalog.error})` : ""}.</p>}
            </>
          )}
          {/* The pool's model can't answer while it's off: starting it again is the way out here (the other, another
              account for the chat, is in the chat's settings — this menu holds the pool's one model). */}
          {pool && !pool.ready && (
            <button type="button" className="link-btn small" style={{ margin: "0 10px 8px" }} onClick={() => { setMenu(null); openModelPool(); }}>
              Open Model pool
            </button>
          )}
          <ModelChoices models={models} current={current?.id ?? null} note={moreNote} onChoose={chooseModel} />
          {actual && !current && (
            <MenuItem
              on
              tone={gone ? "warn" : ""}
              title={actual}
              help={gone ? `${agentName} doesn't list this model now, so replies may fail. Pick one above.` : "Set in chat settings."}
              onClick={() => setMenu(null)}
            />
          )}
          {helpersOffered && (
            <label className="compact-row helper-row">
              <span>Helper agents use</span>
              <HelperSelect
                models={models}
                own={current?.resolvedModel ?? current?.id ?? ""}
                value={helperId}
                onChange={(v) => {
                  const config = { ...member.config };
                  if (v) config.helperModel = v;
                  else delete config.helperModel;
                  void patch({ config });
                }}
              />
              <span className="pop-note">{helperHelp(member.provider)}</span>
            </label>
          )}
        </Pop>
      )}
      {menu === "effort" && current && (
        <Pop side="right" title="Effort">
          <EffortSlider
            levels={levels}
            value={shownEffort}
            defaultLevel={current.defaultEffort}
            agentName={PROVIDER_INFO[member.provider].name}
            onCommit={(v) => {
              const config = { ...member.config };
              if (v && v !== current.defaultEffort) config.effort = v;
              else delete config.effort;
              void patch({ config });
            }}
          />
          {ultracodeOffered && (
            <div className="ultracode-row">
              <div style={{ flex: 1 }}>
                <div className="pop-item-title">Ultracode</div>
                <div className="pop-item-help">Claude plans big tasks and runs several agents at once. Much faster on large work, and uses much more of your plan.</div>
              </div>
              <Switch
                checked={ultracode}
                label="Ultracode"
                onChange={(on) => {
                  const config = { ...member.config };
                  if (on) config.ultracode = true;
                  else delete config.ultracode;
                  void patch({ config });
                }}
              />
            </div>
          )}
        </Pop>
      )}
      {menu === "context" && <ContextPop room={room} member={member} model={exact} patch={patch} onDone={() => setMenu(null)} />}
    </div>
  );
}

/**
 * A menu over the row. It rises a touch out of the row (motion-chat.css), live and its full size from its first frame; when
 * it closes it's gone at once, and a copy fades where it was (motion.ts `leave`).
 */
function useMenuExit() {
  const menu = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => () => leave(menu.current, "menu"), []);
  return menu;
}

function Pop({ side, title, children }: { side: "left" | "right"; title: string; children: ReactNode }) {
  const menu = useMenuExit();
  return (
    <div ref={menu} className={`ctl-pop ${side}`} role="dialog" aria-label={title}>
      <div className="pop-title">{title}</div>
      {children}
    </div>
  );
}

/**
 * Effort as a slider from cool to hot. "" is the agent's own default (Claude Code doesn't say which level that is).
 * Saved when the finger lifts, so dragging across levels doesn't send each one.
 */
function EffortSlider({ levels, value, defaultLevel, agentName, onCommit }: { levels: string[]; value: string; defaultLevel: string | null; agentName: string; onCommit: (v: string) => void }) {
  const known = levels.indexOf(value);
  const [i, setI] = useState(known >= 0 ? known : Math.floor((levels.length - 1) / 2));
  const [unset, setUnset] = useState(known < 0);
  const committed = useRef(known >= 0 ? known : -1);
  const commitAt = (n: number) => {
    setI(n);
    setUnset(false);
    if (n === committed.current) return;
    committed.current = n;
    onCommit(levels[n]);
  };
  const heat = levels.length > 1 ? i / (levels.length - 1) : 0;
  const isDefault = unset || levels[i] === defaultLevel;
  return (
    <div className={`effort ${unset ? "unset" : ""}`}>
      <div className="effort-now">
        <span className="effort-word" style={{ ["--heat" as string]: heat }}>{unset ? "Default" : EFFORT_LABELS[levels[i]] ?? levels[i]}</span>
        {isDefault && !unset && <span className="pop-badge">Default</span>}
        {!isDefault && (
          <button className="link-btn small" style={{ marginLeft: "auto" }} onClick={() => { committed.current = -1; setUnset(!defaultLevel); if (defaultLevel) setI(Math.max(0, levels.indexOf(defaultLevel))); onCommit(""); }}>
            Use default
          </button>
        )}
      </div>
      <input
        type="range"
        className="effort-range"
        min={0}
        max={levels.length - 1}
        step={1}
        value={i}
        onChange={(e) => { setI(Number(e.target.value)); setUnset(false); }}
        onPointerUp={(e) => commitAt(Number((e.target as HTMLInputElement).value))}
        onKeyUp={(e) => commitAt(Number((e.target as HTMLInputElement).value))}
        aria-label="Effort"
        aria-valuetext={unset ? "Default" : EFFORT_LABELS[levels[i]] ?? levels[i]}
      />
      <div className="effort-ticks" aria-hidden="true">
        {levels.map((l, n) => (
          <button key={l} className={!unset && n === i ? "on" : ""} tabIndex={-1} onClick={() => commitAt(n)}>
            {effortWord(l)}
          </button>
        ))}
      </div>
      <p className="pop-note">{unset ? `${agentName} picks how hard to think. Slide to choose yourself. ` : ""}Higher thinks longer and uses more of your plan.</p>
    </div>
  );
}

/** The newest context reading for this chat's agent: from its last finished turn that reported one. */
function useContextReading(room: Room, member: Member) {
  return useStore((s) => {
    const turns = Object.values(s.roomData[room.id]?.turns ?? {});
    let best: { tokens: number; window: number | null; at: number } | null = null;
    for (const t of turns) {
      const tokens = t.usage?.contextTokens;
      if (t.memberId !== member.id || typeof tokens !== "number" || tokens <= 0) continue;
      const at = t.endedAt ?? t.startedAt ?? t.createdAt;
      if (!best || at > best.at) best = { tokens, window: t.usage?.contextWindow ?? null, at };
    }
    return best ? `${best.tokens}|${best.window ?? ""}` : "";
  });
}

function parseContext(s: string): { tokens: number; window: number | null } | null {
  if (!s) return null;
  const [t, w] = s.split("|");
  return { tokens: Number(t), window: w ? Number(w) : null };
}

/**
 * How full this chat's context is: the newest reading's tokens against what the chat's model holds, as its agent's
 * model list says (so a model just switched to, or long context just turned on, counts at once). Without a list
 * entry, the window the agent reported with the reading.
 */
function useChatContext(room: Room, member: Member, model: ModelOption | undefined): { tokens: number | null; window: number | null; size: ChatContextSize | null } {
  const reading = parseContext(useContextReading(room, member));
  const size = chatContextSize(model, member.provider === "codex" && wantsLongContext(member.config));
  return { tokens: reading?.tokens ?? null, window: size?.usable ?? reading?.window ?? null, size };
}

const toneFor = (pct: number) => (pct >= 90 ? "full" : pct >= 70 ? "warn" : "");

function ContextRingButton({ room, member, model, open, onClick }: { room: Room; member: Member; model: ModelOption | undefined; open: boolean; onClick: () => void }) {
  const ctx = useChatContext(room, member, model);
  const pct = ctx.tokens && ctx.window ? Math.min(100, (ctx.tokens / ctx.window) * 100) : 0;
  const r = 7;
  const c = 2 * Math.PI * r;
  return (
    <button className="ctl ring-btn" onClick={onClick} aria-expanded={open} aria-label={ctx.tokens && ctx.window ? `Context ${Math.round(pct)}% full. Show context and plan limits` : "Show context and plan limits"} title="Context and plan limits">
      <svg width="18" height="18" viewBox="0 0 18 18" aria-hidden="true">
        <circle cx="9" cy="9" r={r} className="ring-track" />
        {pct > 0 && <circle cx="9" cy="9" r={r} className={`ring-fill ${toneFor(pct)}`} strokeDasharray={`${Math.max(1.5, (pct / 100) * c)} ${c}`} transform="rotate(-90 9 9)" />}
      </svg>
    </button>
  );
}

/** When a chat summarizes older messages by itself: the agent's own default, or a size you pick to save usage. */
const COMPACT_AT = [100_000, 200_000, 400_000, 600_000, 800_000];

/** A compaction size picked for a bigger window that the new one doesn't reach goes back to the agent's default. */
function fitCompaction(config: Record<string, unknown>, size: ChatContextSize | null) {
  const n = config.autoCompact;
  if (typeof n === "number" && size && n >= (size.compactAt ?? size.usable)) delete config.autoCompact;
}

export function ContextPop({ room, member, model, patch, onDone }: { room: Room; member: Member; model: ModelOption | undefined; patch: (body: Partial<Member>) => Promise<void>; onDone: () => void }) {
  const toast = useStore((s) => s.toast);
  const ctx = useChatContext(room, member, model);
  const agent = PROVIDER_INFO[member.provider].name;
  const busy = ["thinking", "working", "approval", "queued"].includes(member.status);
  const compactAt = typeof member.config?.autoCompact === "number" ? member.config.autoCompact : null;
  // Sizes below where the agent compacts by itself (else below what the chat holds).
  const limit = ctx.size?.compactAt ?? ctx.window;
  const choices = COMPACT_AT.filter((n) => !limit || n < limit);
  // What the default really is. Larger sizes stay offered on a service: the chat can pick later than its default.
  // An older machine's hub compacts a service's chat at three quarters of its window, which it doesn't say to the app.
  const olderHub = useStore((s) => olderThan(s.hub?.version, "0.6.6"));
  const defaultAt = ctx.size?.compactAt ?? (olderHub ? null : serviceCompactPoint(member.provider, ctx.window));
  const setCompactAt = (v: string) => {
    const config = { ...member.config };
    if (v) config.autoCompact = Number(v);
    else delete config.autoCompact;
    void patch({ config });
  };
  // Codex can give a chat more than its model's usual window (the most its model list allows).
  const longOffered = member.provider === "codex" && !!model?.contextWindow && !!model.maxContextWindow && model.maxContextWindow > model.contextWindow;
  const long = longOffered && wantsLongContext(member.config);
  const setLong = (on: boolean) => {
    const config = { ...member.config };
    if (on) config.longContext = true;
    else delete config.longContext;
    fitCompaction(config, chatContextSize(model, on));
    void patch({ config });
  };
  const compactNow = async () => {
    try {
      await api("POST", `/api/rooms/${room.id}/messages`, { text: "/compact" });
      onDone();
    } catch (e) {
      toast("error", e instanceof Error ? e.message : String(e));
    }
  };
  const usage = useStore((s) => s.usage[accountKey(member.provider, memberAccount(member))]);
  const windows = (usage?.windows ?? []).filter((w) => w.usedPercent !== null);
  // A service tells Crosstalk nothing about limits, so "Not checked yet" would never come true.
  const service = useStore((s) => s.accounts[accountKey(member.provider, memberAccount(member))]?.kind === "endpoint");
  const pct = ctx.tokens !== null && ctx.window ? Math.min(100, Math.round((ctx.tokens / ctx.window) * 100)) : null;
  // Codex keeps part of the window for its instructions and the reply: the conversation fills the rest.
  const reserve = ctx.size && ctx.size.usable < ctx.size.window ? Math.round(100 - (ctx.size.usable / ctx.size.window) * 100) : 0;
  const menu = useMenuExit();
  return (
    <div ref={menu} className="ctl-pop right" role="dialog" aria-label="Context and plan limits">
      <div className="pop-title">Context window</div>
      {ctx.tokens !== null ? (
        <div className="usage-line">
          <span className="usage-label">{formatTokens(ctx.tokens)}{ctx.window ? ` of ${contextSize(ctx.window)}` : ""}</span>
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
        <p className="pop-note">{ctx.window ? `Holds ${contextSize(ctx.window)}. ` : ""}Shows how full it is after {agent}'s next reply.</p>
      )}
      <ChatCostLine room={room} member={member} />
      {model && ctx.size && (reserve > 0 || ctx.size.long) && (
        <p className="pop-note">
          {model.label} has {contextSize(ctx.size.window)}{ctx.size.long ? " with long context" : ""}
          {reserve > 0 ? `; ${agent} keeps ${reserve}% of it for its instructions and the reply.` : "."}
        </p>
      )}
      {/* A group chat's messages go to who they're for: "/compact" there would be a message, not the agent's command. */}
      {pct !== null && pct >= 80 && !room.chat?.group && <p className="pop-note">Nearly full. Compact now to free it up.</p>}
      {longOffered && (
        <div className="ultracode-row">
          <div style={{ flex: 1 }}>
            <div className="pop-item-title">Long context</div>
            <div className="pop-item-help">
              Up to {contextSize(model!.maxContextWindow!)} instead of {contextSize(model!.contextWindow!)}, so it compacts less often. Long chats use your plan faster.{busy ? " Starts with the next reply." : ""}
            </div>
          </div>
          <Switch checked={long} label="Long context" onChange={setLong} />
        </div>
      )}
      <label className="compact-row">
        <span>Compact automatically at</span>
        <select className="select" value={compactAt ?? ""} onChange={(e) => setCompactAt(e.target.value)}>
          <option value="">{agent}'s default ({defaultAt ? contextSize(defaultAt) : "near full"})</option>
          {[...new Set([...choices, ...(compactAt ? [compactAt] : [])])].sort((a, b) => a - b).map((n) => (
            <option key={n} value={n}>
              {formatTokens(n)} tokens
            </option>
          ))}
        </select>
      </label>
      <p className="pop-note">Compacting summarizes older messages so each reply reads less. A smaller size saves usage; the agent remembers less detail.</p>
      {!room.chat?.group && (
        <button className="btn small block" disabled={busy} onClick={compactNow} title={busy ? "Available when the agent isn't working" : undefined}>
          Compact now
        </button>
      )}
      {(!service || windows.length > 0) && (
        <>
          <div className="pop-title" style={{ marginTop: 12 }}>
            Plan limits{usage?.plan ? <span className="muted"> · {usage.plan}</span> : null}
          </div>
          {windows.length ? windows.map((w) => <UsageLine key={w.label} w={w} />) : <p className="pop-note">{usage ? "No limits reported for this account." : "Not checked yet."}</p>}
        </>
      )}
    </div>
  );
}
