import { useId, useState } from "react";
import { Copy, Pencil, Plus, Trash2 } from "lucide-react";
import { EFFORT_LABELS, PROVIDER_INFO, groupAnswers, groupMode, permissionInfo, type GroupAnswers, type Member, type Room } from "@crosstalk/shared";
import { api } from "../api";
import { nameEdit } from "../chatName";
import { accountKey, memberAccount } from "../accounts";
import { deleteRoomHere, useMachines, useStore } from "../store";
import { isPinned, pinChat, pinFailed } from "../pins";
import { ANSWER_OPTIONS } from "../groupChat";
import { parallelWorkHelp } from "../teamwork";
import { ChoiceCards, Dialog, MemberAvatar, Stepper, Switch } from "../ui";
import { AgentDialog } from "./AgentDialog";
import { ExportMarkdownButton } from "./ExportMarkdownButton";
import { GroupAvatar } from "./GroupAvatar";
import { TwoStepDialog } from "./TwoStepDialog";

const BUSY = ["thinking", "working", "queued", "approval"];

/** One agent's line in a group chat's settings: its kind, account, model, effort and what it may do. */
function memberLine(m: Member, accountLabel: string | null): string {
  const effort = typeof m.config?.effort === "string" && m.config.effort ? `${EFFORT_LABELS[m.config.effort] ?? m.config.effort} effort` : null;
  return [PROVIDER_INFO[m.provider]?.name ?? m.provider, accountLabel, m.resolvedModel ?? m.model ?? "Default model", effort, permissionInfo(m.provider, m.permissionMode).short].filter(Boolean).join(" · ");
}

/**
 * A group chat's settings: its name, who answers a message that names nobody and who leads, its agents (each opens in
 * its own dialog: account, permissions, name, model, effort, role, starting fresh, leaving; more can join), whether
 * other chats' agents can read it, pinning, and the chat's own actions. Model and effort are also under the message box.
 */
export function GroupSettingsDialog({ room, members, machine, onClose, onDuplicate }: { room: Room; members: Member[]; machine: string | null; onClose: () => void; onDuplicate: () => void }) {
  const toast = useStore((s) => s.toast);
  const setView = useStore((s) => s.setView);
  const accounts = useStore((s) => s.accounts);
  // Everything here is measured from how it was when this opened, never from how the chat is right now: another device
  // can rename the chat or change these while it's open, and what it did stays. Only what was changed here is saved.
  const [nameAtOpen] = useState(() => room.name);
  const [name, setName] = useState(nameAtOpen);
  const [answersAtOpen] = useState<GroupAnswers>(() => groupAnswers(room.mode));
  const [answers, setAnswers] = useState<GroupAnswers>(answersAtOpen);
  // Who leads: the chat's own until you pick (an agent's dialog can make another the lead meanwhile).
  const [leadPick, setLead] = useState<string | null>(null);
  const [roundsAtOpen] = useState(() => Math.max(1, Math.ceil(room.maxHops / 2)));
  const [rounds, setRounds] = useState(roundsAtOpen);
  const [reachableAtOpen] = useState(() => !room.privateFromAgents);
  const [reachable, setReachable] = useState(reachableAtOpen);
  const [parallelAtOpen] = useState(() => room.parallel);
  const [parallel, setParallel] = useState(parallelAtOpen);
  const [pinnedAtOpen] = useState(() => isPinned(room));
  const [pinned, setPinned] = useState(pinnedAtOpen);
  const machines = useMachines((m) => m.list);
  const active = useStore((s) => s.active);
  const [busy, setBusy] = useState(false);
  const [asking, setAsking] = useState<"delete" | null>(null);
  // An agent being changed (or added: "new") in its own dialog: account, permissions, name, model, effort, role.
  const [editing, setEditing] = useState<Member | "new" | null>(null);
  const working = members.some((m) => BUSY.includes(m.status));
  const initialLead = room.leadMemberId ?? members[0]?.id ?? "";
  const lead = leadPick ?? initialLead;
  const nameId = useId();
  const said = nameEdit(name, nameAtOpen, room.name);
  const changed = { name: said.changed, answers: answers !== answersAtOpen, rounds: rounds !== roundsAtOpen, reachable: reachable !== reachableAtOpen, parallel: parallel !== parallelAtOpen, pinned: pinned !== pinnedAtOpen };
  const dirty = changed.name || changed.answers || lead !== initialLead || (answers === "review" && changed.rounds) || changed.reachable || changed.parallel || changed.pinned;
  const accountLabel = (m: Member) => {
    const id = memberAccount(m);
    return id === "default" ? null : accounts[accountKey(m.provider, id)]?.label ?? id;
  };

  const act = async (fn: () => Promise<void>) => {
    setBusy(true);
    try {
      await fn();
    } catch (e) {
      toast("error", e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };
  const save = () =>
    act(async () => {
      const patch: Partial<Room> = {};
      if (said.send) patch.name = said.send;
      if (changed.answers && answers !== groupAnswers(room.mode)) patch.mode = groupMode(answers);
      if (lead && lead !== initialLead) patch.leadMemberId = lead;
      // Build & review counts a round as the lead's work and its review (Room.maxHops).
      if (answers === "review" && (changed.answers || changed.rounds)) patch.maxHops = rounds * 2 - 1;
      if (changed.reachable && reachable !== !room.privateFromAgents) patch.privateFromAgents = !reachable;
      if (changed.parallel && parallel !== room.parallel) patch.parallel = parallel;
      if (Object.keys(patch).length) await api("PATCH", `/api/rooms/${room.id}`, patch);
      // Last: a machine with an older Crosstalk can't pin. It says so, with the rest saved and the dialog left open.
      if (changed.pinned && pinned !== isPinned(room)) {
        const here = machines.find((m) => m.key === active);
        if (!here) throw new Error("This chat's machine isn't connected yet. Try again in a moment.");
        try {
          await pinChat(here, room.id, pinned, machines);
        } catch (e) {
          pinFailed(e);
          return;
        }
      }
      onClose();
    });

  const answerHelp = ANSWER_OPTIONS.find((o) => o.id === answers)?.help ?? "";
  return (
    <Dialog
      title="Group chat settings"
      icon={<GroupAvatar members={members} size="sm" />}
      onClose={onClose}
      dirty={dirty}
      footer={(requestClose) => (
        <>
          <button className="btn" onClick={() => requestClose()}>
            Cancel
          </button>
          <button className="btn primary" disabled={busy || !dirty || !!said.problem} onClick={save}>
            Save
          </button>
        </>
      )}
    >
      {(requestClose) => (
        <>
          <label className="field">
            <span>Name</span>
            <input className="input" value={name} maxLength={80} onChange={(e) => setName(e.target.value)} aria-invalid={!!said.problem} aria-describedby={said.problem ? nameId : undefined} />
          </label>
          {said.problem && (
            <p className="help" id={nameId} style={{ margin: "-6px 0 12px", color: "var(--orange)" }}>
              {said.problem}
            </p>
          )}
          <div className="field">
            <span>When you @name nobody</span>
            <ChoiceCards label="When you @name nobody" value={answers} onChange={setAnswers} options={ANSWER_OPTIONS} />
            {answers === "review" && members.length < 2 && <span className="help" style={{ color: "var(--orange)" }}>Build &amp; review needs two agents. Add another one below.</span>}
          </div>
          {members.length > 0 && (
            <label className="field">
              <span>Lead</span>
              <select className="select" aria-label="Lead" value={lead} onChange={(e) => setLead(e.target.value)}>
                {members.map((m) => (
                  <option key={m.id} value={m.id}>
                    @{m.handle} ({PROVIDER_INFO[m.provider]?.name ?? m.provider})
                  </option>
                ))}
              </select>
              <span className="help">{answers === "turns" ? "Answers first; the others follow in the order below." : answers === "review" ? "Does the work; the next agent below checks it." : answerHelp}</span>
            </label>
          )}
          {answers === "review" && (
            <div className="field">
              <span>Most review rounds</span>
              <Stepper label="review rounds" value={rounds} min={1} max={25} onChange={setRounds} unit={(n) => `${n} round${n === 1 ? "" : "s"}`} />
              <span className="help">One round is the lead's work, then the review. The loop stops as soon as the reviewer approves.</span>
            </div>
          )}

          <div className="field">
            <span>Agents</span>
            <span className="help">Change one to set its account, permissions, name or role. Its model and effort are also under the message box.</span>
            <ul className="group-members" aria-label="Agents in this chat">
              {members.map((m) => (
                <li key={m.id} className="group-member">
                  <MemberAvatar member={m} size="sm" showState />
                  <span className="group-member-text">
                    <strong>
                      @{m.handle}
                      {m.id === (room.leadMemberId ?? members[0]?.id) && <span className="pill">Lead</span>}
                    </strong>
                    <span className="group-member-sub">{memberLine(m, accountLabel(m))}</span>
                  </span>
                  <span className="group-member-actions">
                    <button className="btn small" disabled={busy} onClick={() => setEditing(m)} aria-label={`Change @${m.handle}`}>
                      <Pencil size={13} /> Change
                    </button>
                  </span>
                </li>
              ))}
            </ul>
            <button className="btn small" style={{ marginTop: 8, alignSelf: "flex-start" }} disabled={busy} onClick={() => setEditing("new")}>
              <Plus size={14} /> Add an agent
            </button>
          </div>

          <div className="row" style={{ gap: 12, margin: "4px 0 12px" }}>
            <div style={{ flex: 1 }}>
              <div style={{ fontWeight: 600 }}>Let agents work at the same time</div>
              <div className="help">{parallelWorkHelp(parallel, answers === "review" ? "review" : "direct")}</div>
            </div>
            <Switch checked={parallel} onChange={setParallel} label="Let agents work at the same time" />
          </div>
          <div className="row" style={{ gap: 12, margin: "4px 0 12px" }}>
            <div style={{ flex: 1 }}>
              <div style={{ fontWeight: 600 }}>Other chats' agents can read this chat</div>
              <div className="help">When "Let agents reach your other chats" is on (Settings → Teamwork). They can't message a group chat. Off keeps it private, and its agents don't reach other chats either.</div>
            </div>
            <Switch checked={reachable} onChange={setReachable} label="Other chats' agents can read this chat" />
          </div>
          <div className="row" style={{ gap: 12, margin: "4px 0 12px" }}>
            <div style={{ flex: 1 }}>
              <div style={{ fontWeight: 600 }}>Pinned</div>
              <div className="help">Stays at the top of your chat list, on every device.</div>
            </div>
            <Switch checked={pinned} onChange={setPinned} label="Pinned" />
          </div>
          <div className="field">
            <span>Folder</span>
            <span className="mono small" style={{ overflowWrap: "anywhere" }}>
              {room.cwd}
              {machine && <span className="folder-machine"> on {machine}</span>}
            </span>
            <span className="help">They all work in this folder.</span>
          </div>
          <div className="row wrap" style={{ gap: 8, marginTop: 6 }}>
            <button className="btn small" disabled={busy} onClick={() => requestClose(onDuplicate)}>
              <Copy size={13} /> Duplicate chat…
            </button>
            <ExportMarkdownButton room={room} disabled={busy} />
            <button className="btn small danger" style={{ marginLeft: "auto" }} disabled={busy} onClick={() => setAsking("delete")}>
              Delete chat
            </button>
          </div>

          {asking === "delete" && (
            // Its messages go: asked twice.
            <TwoStepDialog
              title="Delete this chat?"
              icon={<Trash2 size={18} />}
              detail={["Its messages are removed from Crosstalk.", "Files in its folder stay.", working ? "Deleting stops the agents." : null].filter(Boolean).join(" ")}
              sure="This can't be undone."
              confirmLabel="Yes, delete"
              workingLabel="Deleting…"
              agentName="the agents"
              group
              onConfirm={async () => {
                await deleteRoomHere(room.id);
                onClose();
                setView("rooms");
              }}
              onClose={() => setAsking(null)}
            />
          )}
          {editing && <AgentDialog room={room} member={editing === "new" ? null : editing} onClose={() => setEditing(null)} />}
        </>
      )}
    </Dialog>
  );
}
