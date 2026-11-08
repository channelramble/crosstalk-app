// What one agent is always allowed in one chat ("Always allow" on a request), with Remove per rule. Shown in a chat's
// own settings and in a group chat's (or a room's) agent dialog: the rules are kept per agent whatever kind of chat it
// is, so every kind of chat must be able to show them and take one back.
import { useEffect, useState, type ReactNode } from "react";
import type { AlwaysAllowed, Member } from "@crosstalk/shared";
import { api } from "../api";
import { useStore } from "../store";

/** A label with `code` in it, the code shown as code. */
function withCode(label: string): ReactNode {
  return label.split(/`([^`]*)`/).map((part, i) => (i % 2 ? <code key={i}>{part}</code> : part));
}

/**
 * What's always allowed in this chat, each with Remove: the agent asks about it again. Nothing shows when there's none
 * (or the machine's Crosstalk can't list them).
 */
export function AlwaysAllowedList({ member, agentName }: { member: Member; agentName: string }) {
  const toast = useStore((s) => s.toast);
  const [list, setList] = useState<AlwaysAllowed[] | null>(null);
  const [removing, setRemoving] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    api<AlwaysAllowed[]>("GET", `/api/members/${member.id}/always`)
      .then((l) => live && setList(Array.isArray(l) ? l : []))
      .catch(() => live && setList([]));
    return () => {
      live = false;
    };
  }, [member.id]);
  if (!list?.length) return null;
  const remove = async (g: AlwaysAllowed) => {
    setRemoving(g.id);
    try {
      setList(await api<AlwaysAllowed[]>("DELETE", `/api/members/${member.id}/always`, { id: g.id }));
    } catch (e) {
      toast("error", e instanceof Error ? e.message : String(e));
    } finally {
      setRemoving(null);
    }
  };
  return (
    <div className="field">
      <span>Always allowed</span>
      <span className="help">{agentName} doesn't ask before these in this chat. Stricter permissions take them all back.</span>
      <ul className="always-list">
        {list.map((g) => (
          <li key={g.id}>
            <span className="always-label">{withCode(g.label)}</span>
            <button className="btn small" disabled={removing !== null} onClick={() => void remove(g)} aria-label={`Remove: ${g.label.replace(/`/g, "")}`}>
              {removing === g.id ? "Removing…" : "Remove"}
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}
