import { useState } from "react";
import { type Member, type Room } from "@crosstalk/shared";
import { api } from "../api";
import { TEAMWORK_OPTIONS, parallelWorkHelp, teamworkMode, type TeamworkMode } from "../teamwork";
import { deleteRoomHere, useStore } from "../store";
import { ChoiceCards, Dialog, Stepper, Switch, copyText } from "../ui";
import { useMachineName } from "./MachinePicker";

export function RoomSettingsDialog({ room, members, onClose }: { room: Room; members: Member[]; onClose: () => void }) {
  const toast = useStore((s) => s.toast);
  const machine = useMachineName();
  const [name, setName] = useState(room.name);
  const [mode, setMode] = useState<TeamworkMode>(teamworkMode(room.mode));
  const [lead, setLead] = useState(room.leadMemberId ?? "");
  const [maxHops, setMaxHops] = useState(room.maxHops);
  const [parallel, setParallel] = useState(room.parallel);
  const [cwd, setCwd] = useState(room.cwd);
  const [busy, setBusy] = useState(false);
  const formValues = JSON.stringify({ name, mode, lead, maxHops, parallel, cwd });
  const [initialValues] = useState(formValues);
  const dirty = formValues !== initialValues;
  const folder = cwd.trim();
  const folderError = !folder || !(folder.startsWith("/") || folder.startsWith("~/"))
    ? `Enter a full folder path on ${machine}, starting with / or ~/.`
    : "";

  const save = async () => {
    if (busy || folderError) return;
    setBusy(true);
    try {
      await api("PATCH", `/api/rooms/${room.id}`, { name, mode, leadMemberId: lead || null, ...(mode === "review" ? { maxHops: Math.max(1, Math.ceil(maxHops / 2)) * 2 - 1 } : {}), parallel, cwd: folder !== room.cwd ? folder : undefined });
      toast("info", "Room settings saved.");
      onClose();
    } catch (e) {
      toast("error", e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const del = async () => {
    if (busy) return;
    if (!confirm(`Delete "${room.name}"? The chat history is removed. The project folder on the hub is kept.`)) return;
    if (!confirm(`Final confirmation: permanently delete the "${room.name}" conversation and its settings? This cannot be undone. Your project files will stay on the hub.`)) return;
    setBusy(true);
    try {
      await deleteRoomHere(room.id);
      onClose();
    } catch (e) {
      toast("error", e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const brief = async () => {
    // A hand-off note for agents that can't join the room (e.g. ChatGPT dots).
    const data = useStore.getState().roomData[room.id];
    const msgs = (data?.messages ?? []).filter((m) => m.authorKind !== "system").slice(-30);
    const lines = [
      `Project: ${room.name} (folder ${room.cwd})`,
      `Team: ${members.map((m) => `@${m.handle}`).join(", ")}`,
      "",
      "Recent conversation:",
      ...msgs.map((m) => `- ${m.authorKind === "human" ? "Me" : "@" + m.authorName}: ${m.text.replace(/\s+/g, " ").slice(0, 400)}`),
      "",
      "Please pick this up from here.",
    ];
    if (await copyText(lines.join("\n"))) toast("info", "Room brief copied. Paste it into ChatGPT to hand off to a dot.");
    else toast("error", "Couldn't copy to the clipboard.");
  };

  return (
    <Dialog
      title="Room settings"
      onClose={onClose}
      dirty={dirty}
      footer={(requestClose) => (
        <>
          <button className="btn" onClick={() => requestClose()}>
            Cancel
          </button>
          <button className="btn primary" onClick={save} disabled={busy || !!folderError}>
            {busy ? "Saving…" : "Save"}
          </button>
        </>
      )}
    >
      {(requestClose) => (
        <>
          <label className="field">
            <span>Name</span>
            <input className="input" value={name} onChange={(e) => setName(e.target.value)} />
          </label>

          <h4 className="section-title">Agent teamwork</h4>
          {/* Not a <label>: tapping text inside a label would click its first button and reset the choice. */}
          <div className="field">
            <ChoiceCards label="Agent teamwork" value={mode} onChange={setMode} options={TEAMWORK_OPTIONS} />
          </div>
          {mode === "review" && members.length < 2 && (
            <p className="help" style={{ color: "var(--orange)" }}>Build &amp; review needs two agents. Add another one from Team.</p>
          )}
          {members.length > 0 && (
            <label className="field">
              <span>Default agent</span>
              <select className="select" aria-label="Default agent" aria-describedby="room-default-agent-help" value={lead} onChange={(e) => setLead(e.target.value)}>
                <option value="">{`First agent (@${members[0].handle})`}</option>
                {members.map((m) => (
                  <option key={m.id} value={m.id}>
                    @{m.handle}
                  </option>
                ))}
              </select>
              <span id="room-default-agent-help" className="help">
                {mode === "review"
                    ? (() => {
                        const builder = members.find((m) => m.id === lead) ?? members[0];
                        const reviewer = members.find((m) => m.id !== builder.id);
                        return reviewer ? `Does the work. @${reviewer.handle} reviews it and they iterate until it's approved.` : "Does the work. Add a second agent to review it.";
                      })()
                    : "Gets your messages when you don't @mention anyone."}
              </span>
            </label>
          )}
          {mode === "review" && (
            <div className="field">
              <span>Most review rounds</span>
              <Stepper label="review rounds" value={Math.max(1, Math.ceil(maxHops / 2))} min={1} max={25} onChange={(n) => setMaxHops(n * 2 - 1)} unit={(n) => `${n} round${n === 1 ? "" : "s"}`} />
              <span className="help">One round is the builder working, then the reviewer checking. Fewer rounds use less of your plan; the loop stops early as soon as the reviewer approves.</span>
            </div>
          )}
          <div className="row" style={{ marginBottom: 14 }}>
            <div style={{ flex: 1 }}>
              <div style={{ fontWeight: 600 }}>Let agents work at the same time</div>
              <div className="help">{parallelWorkHelp(parallel, mode)}</div>
            </div>
            <Switch checked={parallel} onChange={setParallel} label="Let agents work at the same time" />
          </div>

          <h4 className="section-title">Team</h4>
          <div className="row" style={{ marginBottom: 14 }}>
            <div style={{ flex: 1 }}>
              <div style={{ fontWeight: 600 }}>Agents and permissions</div>
              <div className="help">Add agents, and choose what each one is allowed to do.</div>
            </div>
            <button className="btn small" onClick={() => requestClose(() => useStore.getState().setShowAgents(true))}>
              Open Team
            </button>
          </div>

          <h4 className="section-title">Project</h4>
          <label className="field">
            <span>Project folder on the hub</span>
            <input className="input mono" aria-label="Project folder on the hub" aria-invalid={!!folderError} aria-describedby={folderError ? "room-folder-error" : undefined} value={cwd} onChange={(e) => setCwd(e.target.value)} autoCapitalize="off" autoCorrect="off" spellCheck={false} />
            {folderError && <span id="room-folder-error" className="help" style={{ color: "var(--red)" }}>{folderError}</span>}
            <span className="help">Where the agents read and edit files. Agents switch to a new folder from their next turn.</span>
          </label>
          <div className="row" style={{ marginBottom: 14 }}>
            <div style={{ flex: 1 }}>
              <div style={{ fontWeight: 600 }}>Brief a ChatGPT dot</div>
              <div className="help">Dots can't join a room. This copies a summary you can paste to one.</div>
            </div>
            <button className="btn small" onClick={brief}>
              Copy brief
            </button>
          </div>

          <div className="divider" />
          <div className="row">
            <div style={{ flex: 1 }}>
              <div style={{ fontWeight: 600, color: "var(--red)" }}>Delete room</div>
              <div className="help">Removes the chat history. The project folder on the hub is kept.</div>
            </div>
            <button className="btn small danger" onClick={del} disabled={busy}>
              Delete
            </button>
          </div>
        </>
      )}
    </Dialog>
  );
}
