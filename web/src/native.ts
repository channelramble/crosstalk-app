// Native-shell integration (Tauri). Loaded only inside the desktop/mobile apps.
import { isNative } from "./api";
import { useStore } from "./store";

export async function initNative() {
  if (!isNative) return;
  const ua = navigator.userAgent;
  const mobile = /iPhone|iPad|Android/.test(ua);
  const root = document.documentElement;
  root.classList.add("native");
  if (/Macintosh/.test(ua) && !mobile) root.classList.add("native-mac");

  // Open web links in the system browser instead of inside the app.
  const { openUrl } = await import("@tauri-apps/plugin-opener");
  document.addEventListener(
    "click",
    (e) => {
      const a = (e.target as HTMLElement | null)?.closest?.("a[href]") as HTMLAnchorElement | null;
      if (!a) return;
      const href = a.href;
      if (!/^(https?:|mailto:)/.test(href)) return;
      if (a.target === "_blank" || new URL(href).origin !== location.origin) {
        e.preventDefault();
        void openUrl(href).catch(() => window.open(href, "_blank"));
      }
    },
    true,
  );

  // Native notifications for approvals and errors when the window isn't focused.
  // Ask for permission only once the device is paired, not on the first screen.
  if (!useStore.getState().conn) {
    await new Promise<void>((resolve) => {
      const off = useStore.subscribe((s) => {
        if (s.conn) {
          off();
          resolve();
        }
      });
    });
  }
  const n = await import("@tauri-apps/plugin-notification");
  let allowed = await n.isPermissionGranted().catch(() => false);
  if (!allowed) allowed = (await n.requestPermission().catch(() => "denied")) === "granted";
  if (!allowed) return;
  const seen = new Set<string>();
  const seenErr = new Set<string>();
  useStore.subscribe((s, prev) => {
    if (s.approvals === prev.approvals && s.members === prev.members) return;
    const away = document.visibilityState !== "visible" || !document.hasFocus();
    for (const a of Object.values(s.approvals)) {
      if (a.status !== "pending" || seen.has(a.id)) continue;
      seen.add(a.id);
      if (!away) continue;
      const m = s.members[a.memberId];
      const room = s.rooms[a.roomId];
      n.sendNotification({ title: `@${m?.handle ?? "agent"} needs approval`, body: `${a.title}${room ? ` · ${room.name}` : ""}` });
    }
    for (const m of Object.values(s.members)) {
      const key = `${m.id}:${m.statusDetail}`;
      if (m.status !== "error" || seenErr.has(key) || prev.members[m.id]?.status === "error") continue;
      seenErr.add(key);
      if (away) n.sendNotification({ title: `@${m.handle} hit an error`, body: m.statusDetail ?? "" });
    }
  });
}
