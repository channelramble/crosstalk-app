import { useEffect, useRef, useState } from "react";
import { Shield, ShieldAlert, ShieldCheck, Sparkles, Users, Zap } from "lucide-react";
import { helpersOf, turnOrder, type Member, type Room } from "@crosstalk/shared";
import { useStore } from "../store";
import { helpersOnLabel } from "./HelpersOn";
import { memoryWords, type SheetAt } from "../chatSettings";
import { MemberAvatar } from "../ui";
import { useAgentSettings, useChatContext } from "../useAgentSettings";

const toneFor = (pct: number) => (pct >= 90 ? "full" : pct >= 70 ? "warn" : "");

/**
 * The row under a chat's message box: what's in force, in words. On the left what the agent may do ("Asks first"), on
 * the right what answers ("Opus 5.5 · High") and a ring that fills as the model's memory of the chat does. Each opens
 * the chat's settings sheet at its section, where the choice is one more tap. In a group chat (`members`) the words are
 * the lead's, with its picture, and a count of the others opens the sheet at its overview.
 */
export function ChatControls({ room, member: only, members, onOpen }: { room: Room; member: Member; members?: Member[]; onOpen: (at: SheetAt) => void }) {
  const member = (members ? turnOrder(room, members)[0] : undefined) ?? only;
  const s = useAgentSettings(room, member);
  const ctx = useChatContext(room, member, s.exact);
  const box = useRef<HTMLDivElement>(null);
  // A narrow row (a small phone, or a big text size): what it may do shows as an icon, so the model's name has room.
  const [narrow, setNarrow] = useState(false);
  const grouped = !!members;
  useEffect(() => {
    const el = box.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(() => setNarrow(el.clientWidth < (grouped ? 330 : 290)));
    ro.observe(el);
    return () => ro.disconnect();
  }, [grouped]);

  // Another account does its helper work ("Helpers run on", HelpersOn.tsx): the chip marks it, as it marks a helper model.
  const helpersOn = helpersOf(member.config);
  const helpersName = useStore((st) => (helpersOn ? helpersOnLabel(helpersOn, Object.values(st.accounts)) : null));
  const { pct } = memoryWords(ctx.tokens, ctx.window);
  const r = 7;
  const c = 2 * Math.PI * r;
  const others = members ? members.length - 1 : 0;
  const whose = members ? `@${member.handle}'s ` : "";
  return (
    <div className={`chat-controls cs-row${narrow ? " narrow" : ""}`} ref={box} role="group" aria-label="This chat's settings">
      <button className={`ctl cs-chip ctl-may${s.words.danger ? " danger" : ""}`} onClick={() => onOpen({ section: "may", memberId: member.id })} aria-haspopup="dialog" aria-label={`${whose}Permissions: ${s.perm.short}`} title={`${s.perm.short}: what ${members ? `@${member.handle}` : "it"} may do without asking`}>
        {members && <MemberAvatar member={member} size="sm" />}
        {narrow ? s.perm.tone === "red" ? <ShieldAlert size={15} aria-hidden="true" /> : s.perm.tone === "green" ? <ShieldCheck size={15} aria-hidden="true" /> : <Shield size={15} aria-hidden="true" /> : <span className="ellipsis">{s.perm.short}</span>}
      </button>
      <span className="ctl-spacer" />
      <button className="ctl cs-chip ctl-model" onClick={() => onOpen({ section: "answers", memberId: member.id })} aria-haspopup="dialog" aria-label={`${whose}Model: ${s.words.answers}`} title="Model and effort">
        {s.fastOn && <Zap size={13} className="ctl-fast" aria-label="Fast mode" />}
        {helpersOn ? <Users size={13} className="ctl-helpers" aria-label={`Helpers run on ${helpersName}`} /> : s.helper && <Users size={13} className="ctl-helpers" aria-label={`Helper agents use ${s.helper.label}`} />}
        <span className="ellipsis">{s.words.answers}</span>
        {s.ultracode && <Sparkles size={13} className="ctl-ultra" aria-label="Ultracode" />}
      </button>
      {others > 0 && (
        <button className="ctl cs-chip cs-others" onClick={() => onOpen({})} aria-haspopup="dialog" aria-label={`${others} more agent${others === 1 ? "" : "s"}. Open this chat's settings`} title="The other agents' settings">
          +{others}
        </button>
      )}
      <button className="ctl ring-btn" onClick={() => onOpen({ section: "memory", memberId: member.id })} aria-haspopup="dialog" aria-label={pct !== null ? `${whose}Memory ${pct}% full. Open this chat's memory` : `${whose}Memory. Open this chat's memory`} title="How much of the chat the model remembers">
        <svg width="18" height="18" viewBox="0 0 18 18" aria-hidden="true">
          <circle cx="9" cy="9" r={r} className="ring-track" />
          {pct !== null && pct > 0 && <circle cx="9" cy="9" r={r} className={`ring-fill ${toneFor(pct)}`} strokeDasharray={`${Math.max(1.5, (pct / 100) * c)} ${c}`} transform="rotate(-90 9 9)" />}
        </svg>
      </button>
    </div>
  );
}
