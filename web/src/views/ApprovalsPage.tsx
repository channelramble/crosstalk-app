import { useShallow } from "zustand/react/shallow";
import { pendingApprovals, useStore } from "../store";
import { useIsMobile } from "../ui";
import { ApprovalCard } from "./ApprovalCard";

export function ApprovalsPage() {
  const mobile = useIsMobile();
  const approvals = useStore(useShallow((s) => pendingApprovals(s)));
  const members = useStore((s) => s.members);
  const openRoom = useStore((s) => s.openRoom);
  const notif = typeof Notification !== "undefined" ? Notification.permission : "denied";
  return (
    <>
      <header className="topbar" data-tauri-drag-region>
        <div className="titles">
          <h1>Approvals</h1>
          {!mobile && <div className="sub">Commands and edits waiting for your OK, from every room</div>}
        </div>
      </header>
      <div className="page">
        <div className="page-inner">
          {typeof Notification !== "undefined" && notif === "default" && (
            <div className="card" style={{ marginBottom: 12 }}>
              <div className="row">
                <div style={{ flex: 1 }}>
                  <b>Get notified</b>
                  <div className="help">Show a notification when an agent needs approval while this app is in the background.</div>
                </div>
                <button className="btn small primary" onClick={() => Notification.requestPermission().then(() => location.reload())}>
                  Turn on
                </button>
              </div>
            </div>
          )}
          {approvals.length ? (
            approvals.map((a) => (
              <div key={a.id} onDoubleClick={() => openRoom(a.roomId)}>
                <ApprovalCard approval={a} member={members[a.memberId]} showRoom />
              </div>
            ))
          ) : (
            <div className="empty" style={{ minHeight: 320 }}>
              <div>
                <div className="big">Nothing waiting</div>
                <p className="muted small">When an agent wants to run a command or change files and its permissions say "ask", it shows up here.</p>
              </div>
            </div>
          )}
        </div>
      </div>
    </>
  );
}
