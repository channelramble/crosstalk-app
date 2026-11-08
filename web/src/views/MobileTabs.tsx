import { useShallow } from "zustand/react/shallow";
import { BarChart3, Bell, MessagesSquare, Settings2 } from "lucide-react";
import { pendingApprovals, useStore, type View } from "../store";

export function MobileTabs() {
  const view = useStore((s) => s.view);
  const setView = useStore((s) => s.setView);
  const count = useStore(useShallow((s) => pendingApprovals(s))).length;
  const tabs: { id: View; label: string; icon: React.ReactNode; badge?: number }[] = [
    { id: "rooms", label: "Rooms", icon: <MessagesSquare size={22} /> },
    { id: "approvals", label: "Approvals", icon: <Bell size={22} />, badge: count },
    { id: "usage", label: "Usage", icon: <BarChart3 size={22} /> },
    { id: "setup", label: "Settings", icon: <Settings2 size={22} /> },
  ];
  const active = ["devices", "terminal", "settings"].includes(view) ? "setup" : view === "room" ? "rooms" : view;
  return (
    <nav className="tabbar" aria-label="Sections">
      {tabs.map((t) => (
        <button key={t.id} className={active === t.id ? "on" : ""} onClick={() => setView(t.id)}>
          {t.icon}
          {t.label}
          {t.badge ? <span className="count">{t.badge}</span> : null}
        </button>
      ))}
    </nav>
  );
}
