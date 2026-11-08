import { useState } from "react";
import { useShallow } from "zustand/react/shallow";
import { Plus } from "lucide-react";
import { useStore } from "../store";
import { Logo, timeAgo } from "../ui";
import { NewRoomDialog } from "./NewRoomDialog";
import { RoomAvatar } from "./RoomAvatar";

/** Phone home screen: the list of rooms. */
export function RoomsList() {
  const rooms = useStore(useShallow((s) => Object.values(s.rooms).sort((a, b) => b.updatedAt - a.updatedAt)));
  const members = useStore((s) => s.members);
  const approvals = useStore((s) => s.approvals);
  const openRoom = useStore((s) => s.openRoom);
  const status = useStore((s) => s.status);
  const [newRoom, setNewRoom] = useState(false);
  return (
    <>
      <header className="topbar" data-tauri-drag-region>
        <Logo className="logo" />
        <div className="titles">
          <h1>Rooms</h1>
        </div>
        <span className={`status-dot ${status}`} />
        <button className="icon-btn" onClick={() => setNewRoom(true)} aria-label="New room">
          <Plus size={22} />
        </button>
      </header>
      <div className="page">
        {rooms.length ? (
          <div className="list-group">
            {rooms.map((r) => {
              const ms = Object.values(members).filter((m) => m.roomId === r.id);
              const busy = ms.some((m) => ["thinking", "working", "queued"].includes(m.status));
              const waiting = Object.values(approvals).some((a) => a.roomId === r.id && a.status === "pending");
              return (
                <div key={r.id} className="list-row" onClick={() => openRoom(r.id)} role="button" tabIndex={0} onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); openRoom(r.id); } }}>
                  <RoomAvatar roomId={r.id} />
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div className="title">{r.name}</div>
                    <div className="subtitle">{waiting ? "Needs your approval" : busy ? "Agents are working…" : ms.map((m) => `@${m.handle}`).join(", ") || "No agents yet"}</div>
                  </div>
                  <div style={{ textAlign: "right" }}>
                    <div className="tiny muted">{timeAgo(r.updatedAt)}</div>
                    {waiting ? <span className="count">!</span> : busy ? <span className="status-dot connecting" style={{ display: "inline-block" }} /> : null}
                  </div>
                </div>
              );
            })}
          </div>
        ) : (
          <div className="empty" style={{ minHeight: 360 }}>
            <div>
              <div className="big">No rooms yet</div>
              <p className="muted small">A room is a project folder plus the agents working on it.</p>
              <button className="btn primary large" onClick={() => setNewRoom(true)}>
                New room
              </button>
            </div>
          </div>
        )}
      </div>
      {newRoom && <NewRoomDialog onClose={() => setNewRoom(false)} />}
    </>
  );
}
