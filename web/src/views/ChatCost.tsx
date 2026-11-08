// What a chat has cost, and the way out when its account's limit refused a reply (docs/SPEC-0.4.md, track T4).
import { useEffect, useState } from "react";
import { CircleDollarSign } from "lucide-react";
import { useShallow } from "zustand/react/shallow";
import type { Member, Room } from "@crosstalk/shared";
import { api } from "../api";
import { accountOfMember, chatSpendLine, groupRestFigures, groupRestLine, groupSpendLine, limitRefusal, lineFigures, meterState, unpricedLine } from "../spend";
import type { ChatSpend } from "@crosstalk/shared";
import { openCosts } from "../spendNotices";
import { selectRoomMembers, useStore } from "../store";
import { loadSpend } from "../useSpend";
import { LimitDialog } from "./LimitDialog";

/**
 * "This chat: $1.23" (one line, in the context popup under the message box); read again when the hub sends new figures.
 * On a plan sign-in the figure is what the use would cost, and the line says it's included in the plan, so not billed.
 * (It stays here: at 390 px the chat's header line has 208 px, and its model, effort and folder already take 230 to 255.)
 * `member`: the agent whose popup it is. In a group chat each agent can be billed differently, so the line is that
 * agent's part of the chat, in its own account's words (`groupSpendLine`), never another agent's; what is nobody's part
 * (`groupRestLine`: asks, accounts its agents used before) is a second line, in every agent's popup.
 */
export function ChatCostLine({ room, member }: { room: Room; member: Member }) {
  const roomId = room.id;
  const group = !!room.chat?.group;
  // New figures from the hub (after a reply): this chat's may have changed.
  const figures = useStore((s) => s.spend);
  const agents = useStore(useShallow(selectRoomMembers(roomId)));
  const [cost, setCost] = useState<ChatSpend | null>(null);
  useEffect(() => {
    let current = true;
    api<ChatSpend>("GET", `/api/rooms/${roomId}/spend`)
      .then((c) => current && setCost(c))
      // An older hub has no costs: no line.
      .catch(() => current && setCost(null));
    return () => {
      current = false;
    };
  }, [roomId, figures]);
  const account = accountOfMember(figures, member);
  const plan = account?.kind === "signin";
  // Whether the account is a plan sign-in — or a service charging one flat fee for the month, whose replies have no
  // price of their own — comes from its figures: the line waits for them, so a plan chat's figure is never shown as if
  // it were a bill.
  const line = !figures ? null : group ? groupSpendLine(cost, member, agents, figures) : chatSpendLine(cost, plan, !!account?.flat);
  // In a group chat, what is no agent's part (asks to agents outside it, accounts its agents used before) has a line of its
  // own under it: no agent's line covers it. This popup's own agent counts as in the chat even before the store lists it,
  // so its part is never said twice.
  const everyone = agents.some((m) => m.id === member.id) ? agents : [...agents, member];
  const rest = figures && group ? groupRestLine(cost, everyone, figures) : null;
  if (!line && !rest) return null;
  // What the line's figure leaves out: of this agent's part of a group chat when the hub says it, else of the whole chat.
  const unpriced = unpricedLine(lineFigures(cost, member, group)?.unpriced ?? 0);
  const restUnpriced = rest ? unpricedLine(groupRestFigures(cost, everyone)?.unpriced ?? 0) : null;
  return (
    <>
      {line && (
        <p className="pop-note chat-cost" role="status">
          {line}
          {unpriced && <span className="muted"> · {unpriced}</span>}
        </p>
      )}
      {rest && (
        <p className="pop-note chat-cost-rest" role="status">
          {rest}
          {restUnpriced && <span className="muted"> · {restUnpriced}</span>}
        </p>
      )}
    </>
  );
}

/**
 * Raise limit, beside Try again on a reply the hub refused because its account's limit is used up: opens the limit to
 * change right there, or Settings → Costs when this chat's account isn't known (yet). Nothing when the limit isn't the problem.
 * In a group chat, `memberId`: the agent whose reply it was. Each agent has its own account and limit, and the one that
 * refused the reply is the one to raise, whichever agent is first in the chat.
 */
export function RaiseLimit({ room, error, memberId }: { room: Room; error?: string | null; memberId?: string }) {
  const member = useStore((s) => (memberId ? s.members[memberId] : Object.values(s.members).find((m) => m.roomId === room.id)));
  const figures = useStore((s) => s.spend);
  const [open, setOpen] = useState(false);
  const account = member ? accountOfMember(figures, member) : undefined;
  // The figures say so when they have this account (a limit that was raised or removed since is no longer the problem);
  // else the refusal's own words do.
  const stopped = account ? !!account.budget && meterState(account.budget.usedUsd, account.budget.limitUsd) === "stopped" : limitRefusal(error);
  useEffect(() => {
    if (figures === null && stopped) loadSpend().catch(() => {});
  }, [figures === null, stopped]); // eslint-disable-line react-hooks/exhaustive-deps
  // The dialog stays until it closes itself, even though raising the limit means it's no longer the problem.
  if (!stopped && !open) return null;
  return (
    <>
      {stopped && (
        <button className="link-action raise-limit" onClick={() => (account?.budget ? setOpen(true) : openCosts())}>
          <CircleDollarSign size={12} /> Raise limit
        </button>
      )}
      {open && account && <LimitDialog account={account} title="Raise limit" onClose={() => setOpen(false)} />}
    </>
  );
}
