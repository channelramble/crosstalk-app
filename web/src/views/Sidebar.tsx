import { useState } from "react";
import { useShallow } from "zustand/react/shallow";
import { BarChart3, Bell, MonitorSmartphone, Plus, Settings2, SlidersHorizontal, SquareTerminal } from "lucide-react";
import { pendingApprovals, useStore, type View } from "../store";
import { Logo } from "../ui";
import { NewRoomDialog } from "./NewRoomDialog";
import { RoomAvatar } from "./RoomAvatar";

export function Sidebar() {
  const rooms = useStore(useShallow((s) => Object.values(s.rooms).sort((a, b) => b.updatedAt - a.updatedAt)));
  const roomId = useStore((s) => s.roomId);
  const view = useStore((s) => s.view);
  const status = useStore((s) => s.status);
  const hub = useStore((s) => s.hub);
  const openRoom = useStore((s) => s.openRoom);
  const setView = useStore((s) => s.setView);
  const busyRooms = useStore(useShallow((s) => [...new Set(Object.values(s.members).filter((m) => ["thinking", "working", "queued", "approval"].includes(m.status)).map((m) => m.roomId))]));
  const approvals = useStore(useShallow((s) => pendingApprovals(s)));
  const [newRoom, setNewRoom] = useState(false);

  const nav: { id: View; label: string; icon: React.ReactNode; badge?: number }[] = [
    { id: "approvals", label: "Approvals", icon: <Bell size={16} />, badge: approvals.length },
    { id: "usage", label: "Usage", icon: <BarChart3 size={16} /> },
    { id: "setup", label: "Agents & sign-ins", icon: <Settings2 size={16} /> },
    { id: "settings", label: "Settings", icon: <SlidersHorizontal size={16} /> },
    { id: "devices", label: "Devices", icon: <MonitorSmartphone size={16} /> },
    { id: "terminal", label: "Terminal", icon: <SquareTerminal size={16} /> },
  ];

  return (
    <nav className="sidebar" aria-label="Rooms and settings">
      <div className="brand" data-tauri-drag-region>
        <Logo />
        <span>Crosstalk</span>
        <span className={`status-dot ${status}`} title={`${status} · ${hub?.hostname ?? ""}`} />
      </div>
      <div className="side-section scroll" style={{ flex: 1 }}>
        <div className="side-title">
          Rooms
          <button className="icon-btn" style={{ width: 24, height: 24 }} onClick={() => setNewRoom(true)} aria-label="New room" title="New room">
            <Plus size={16} />
          </button>
        </div>
        {rooms.map((r) => (
          <button key={r.id} className={`side-item ${view === "room" && roomId === r.id ? "active" : ""}`} onClick={() => openRoom(r.id)}>
            <RoomAvatar roomId={r.id} compact />
            <span className="label">{r.name}</span>
            {approvals.some((a) => a.roomId === r.id) ? <span className="count">!</span> : busyRooms.includes(r.id) ? <span className="status-dot connecting" /> : null}
          </button>
        ))}
        {!rooms.length && (
          <button className="side-item" onClick={() => setNewRoom(true)}>
            <Plus size={16} />
            <span className="label muted">Start your first room</span>
          </button>
        )}
      </div>
      <div className="side-foot">
        {nav.map((n) => (
          <button key={n.id} className={`side-item ${view === n.id ? "active" : ""}`} onClick={() => setView(n.id)}>
            {n.icon}
            <span className="label">{n.label}</span>
            {n.badge ? <span className="count">{n.badge}</span> : null}
          </button>
        ))}
      </div>
      {newRoom && <NewRoomDialog onClose={() => setNewRoom(false)} />}
    </nav>
  );
}
