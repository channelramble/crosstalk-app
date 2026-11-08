import { useShallow } from "zustand/react/shallow";
import { useState } from "react";
import { Plus, X } from "lucide-react";
import type { PtyInfo } from "@crosstalk/shared";
import { api } from "../api";
import { useStore } from "../store";
import { Terminal } from "./Terminal";
import { SidebarButton } from "./ChatSidebar";
import { MachinePicker } from "./MachinePicker";

export function TerminalPage() {
  const toast = useStore((s) => s.toast);
  const ptys = useStore(useShallow((s) => Object.values(s.ptys).filter((p) => p.alive).sort((a, b) => a.createdAt - b.createdAt)));
  const [active, setActive] = useState<string | null>(null);
  const [opening, setOpening] = useState(false);
  const [closing, setClosing] = useState<string | null>(null);
  const current = ptys.find((p) => p.id === active) ?? ptys[ptys.length - 1];

  const open = async () => {
    if (opening) return;
    setOpening(true);
    try {
      const p = await api<PtyInfo>("POST", "/api/pty", {});
      useStore.setState((s) => ({ ptys: { ...s.ptys, [p.id]: p } }));
      setActive(p.id);
    } catch (e) {
      toast("error", e instanceof Error ? e.message : String(e));
    } finally {
      setOpening(false);
    }
  };
  const close = async (id: string) => {
    if (closing) return;
    setClosing(id);
    try {
      await api("DELETE", `/api/pty/${id}`);
      useStore.setState((s) => {
        const ptys = { ...s.ptys };
        delete ptys[id];
        return { ptys };
      });
    } catch (e) { toast("error", e instanceof Error ? e.message : String(e)); }
    finally { setClosing(null); }
  };

  return (
    <>
      <header className="topbar" data-tauri-drag-region>
        <SidebarButton />
        <div className="titles">
          <h1>Terminal</h1>
          <div className="sub">A shell on the hub, as the user the hub runs as</div>
        </div>
        <MachinePicker />
        <button className="btn small" onClick={open} disabled={opening}>
          <Plus size={14} /> New shell
        </button>
      </header>
      <div className="page" style={{ display: "flex", flexDirection: "column", gap: 10 }}>
        {ptys.length > 0 && (
          <div className="row wrap" style={{ alignSelf: "flex-start", gap: 8 }}>
            {ptys.map((p, i) => (
              <div className="seg" key={p.id}>
              <button className={current?.id === p.id ? "on" : ""} onClick={() => setActive(p.id)} aria-pressed={current?.id === p.id}>
                {p.title} {i + 1}
              </button>
              <button onClick={() => close(p.id)} disabled={!!closing} aria-label={`Close shell ${i + 1}`}><X size={16} /></button>
              </div>
            ))}
          </div>
        )}
        {current ? (
          <Terminal key={current.id} ptyId={current.id} tall />
        ) : (
          <div className="empty">
            <div>
              <div className="big">No shell open</div>
              <p className="muted small">Open a shell to run commands on the hub from any device.</p>
              <button className="btn primary" onClick={open} disabled={opening}>
                Open a shell
              </button>
            </div>
          </div>
        )}
      </div>
    </>
  );
}
