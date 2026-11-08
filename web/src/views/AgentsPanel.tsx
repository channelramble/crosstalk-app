import { useState } from "react";
import { useShallow } from "zustand/react/shallow";
import { ChevronRight, Crown, Plus, Square } from "lucide-react";
import { EFFORT_LABELS, PROVIDER_INFO, permissionInfo, type Member } from "@crosstalk/shared";
import { api } from "../api";
import { pendingApprovals, selectRoomMembers, useStore } from "../store";
import { MemberAvatar, formatTokens, statusLabel } from "../ui";
import { AgentDialog } from "./AgentDialog";
import { ApprovalCard } from "./ApprovalCard";
import { accountKey, accountDescription, memberAccount } from "../accounts";

function effortLabel(m: Member): string | null {
  const e = m.config?.effort;
  return typeof e === "string" && e ? `${EFFORT_LABELS[e] ?? e} effort` : null;
}

export function AgentsPanel({ roomId, compact }: { roomId: string; compact?: boolean }) {
  const room = useStore((s) => s.rooms[roomId]);
  const accounts = useStore((s) => s.accounts);
  const members = useStore(useShallow(selectRoomMembers(roomId)));
  const approvals = useStore(useShallow((s) => pendingApprovals(s, roomId)));
  const totals = useStore((s) => s.roomData[roomId]?.totals);
  const toast = useStore((s) => s.toast);
  const [editing, setEditing] = useState<Member | "new" | null>(null);

  const stopOne = async (m: Member, e: React.MouseEvent) => {
    e.stopPropagation();
    try {
      await api("POST", `/api/rooms/${roomId}/stop`, { memberId: m.id });
    } catch (err) {
      toast("error", err instanceof Error ? err.message : String(err));
    }
  };

  if (!room) return null;
  return (
    <div className="scroll" style={{ flex: 1 }}>
      {!compact && (
        <div className="panel-head">
          <h2>Team & permissions</h2>
          <button className="btn small" onClick={() => setEditing("new")}>
            <Plus size={14} /> Add
          </button>
        </div>
      )}
      {members.map((m) => (
        <div key={m.id} className="agent-row" onClick={() => setEditing(m)} role="button" tabIndex={0} onKeyDown={(e) => { if (e.target === e.currentTarget && (e.key === "Enter" || e.key === " ")) { e.preventDefault(); setEditing(m); } }}>
          <MemberAvatar member={m} showState />
          <div style={{ flex: 1, minWidth: 0 }}>
            <div className="row" style={{ gap: 6 }}>
              <span className="name">@{m.handle}</span>
              {(room.leadMemberId ?? members[0]?.id) === m.id && <Crown size={13} color="var(--orange)" aria-label="Default agent" />}
              <span className="muted tiny">{[PROVIDER_INFO[m.provider].name, m.model, effortLabel(m)].filter(Boolean).join(" · ")}</span>
            </div>
            <div className="detail" style={{ color: m.status === "error" ? "var(--red)" : m.status === "approval" ? "var(--orange)" : undefined }}>
              {statusLabel(m)}
            </div>
            <div className="tiny muted" style={{ overflowWrap: "anywhere" }}>{(() => {
              const a = accounts[accountKey(m.provider, memberAccount(m))];
              return a ? accountDescription(a.label, a.account) : memberAccount(m) === "default" ? "Default account" : "Account unavailable";
            })()}</div>
            <div className="row" style={{ gap: 6, marginTop: 4 }}>
              <span className={`pill ${permissionInfo(m.provider, m.permissionMode).tone}`} title={permissionInfo(m.provider, m.permissionMode).help}>
                {permissionInfo(m.provider, m.permissionMode).short}
              </span>
              <span className="tiny" style={{ color: "var(--accent)", fontWeight: 600 }}>
                Change
              </span>
            </div>
          </div>
          {["thinking", "working", "approval", "queued"].includes(m.status) && (
            <button className="icon-btn" onClick={(e) => stopOne(m, e)} aria-label={`Stop @${m.handle}`} title="Stop">
              <Square size={13} fill="currentColor" />
            </button>
          )}
          <ChevronRight size={18} className="muted" aria-hidden="true" />
        </div>
      ))}
      {compact && (
        <div style={{ padding: "10px 16px" }}>
          <button className="btn block" onClick={() => setEditing("new")}>
            <Plus size={15} /> Add an agent
          </button>
        </div>
      )}
      {!members.length && !compact && (
        <div style={{ padding: "4px 16px 12px" }}>
          <p className="muted small">No agents yet.</p>
          <button className="btn primary block" onClick={() => setEditing("new")}>
            <Plus size={15} /> Add an agent
          </button>
        </div>
      )}

      {approvals.length > 0 && (
        <>
          <div className="panel-head" style={{ paddingTop: 18 }}>
            <h2>Waiting for you</h2>
            <span className="count">{approvals.length}</span>
          </div>
          <div style={{ padding: "0 12px" }}>
            {approvals.map((a) => (
              <ApprovalCard key={a.id} approval={a} member={members.find((m) => m.id === a.memberId)} />
            ))}
          </div>
        </>
      )}

      {totals && (totals.inputTokens > 0 || totals.outputTokens > 0) && (
        <div style={{ padding: "18px 16px" }}>
          <h2 className="section-title" style={{ marginBottom: 8 }}>
            This room
          </h2>
          <div className="small muted">
            {formatTokens(totals.inputTokens)} tokens in · {formatTokens(totals.outputTokens)} out
            {totals.costUsd > 0 ? ` · ≈ $${totals.costUsd.toFixed(2)} at API prices` : ""}
          </div>
        </div>
      )}

      {editing && <AgentDialog room={room} member={editing === "new" ? null : editing} onClose={() => setEditing(null)} />}
    </div>
  );
}
