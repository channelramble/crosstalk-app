import { useState } from "react";
import { FileDown } from "lucide-react";
import { markdownFileName, type Room } from "@crosstalk/shared";
import { exportMarkdown } from "../exportMarkdown";
import { useStore } from "../store";

/** Chat settings → Export as Markdown: the whole chat as a .md file, shared or saved (no steps or tool output). */
export function ExportMarkdownButton({ room, disabled = false }: { room: Pick<Room, "id" | "name">; disabled?: boolean }) {
  const toast = useStore((s) => s.toast);
  const [busy, setBusy] = useState(false);
  const run = async () => {
    setBusy(true);
    try {
      if ((await exportMarkdown(room)) === "saved") toast("info", `Saved ${markdownFileName(room.name)} to this device's downloads.`);
    } catch (e) {
      toast("error", `Couldn't export this chat. ${e instanceof Error ? e.message : String(e)}`, { action: { label: "Try again", run: () => void run() } });
    } finally {
      setBusy(false);
    }
  };
  return (
    <button className="btn small" disabled={busy || disabled} onClick={run}>
      <FileDown size={13} /> {busy ? "Exporting…" : "Export as Markdown"}
    </button>
  );
}
