import { MessagesSquare } from "lucide-react";
import { PROVIDER_INFO } from "@crosstalk/shared";
import { useStore } from "../store";
import { contributionSize, roomContributors } from "../roomActivity";

/** A room's contributors, including historical agents no longer in its team. */
export function RoomAvatar({ roomId, compact = false }: { roomId: string; compact?: boolean }) {
  const activity = useStore((s) => s.roomActivity[roomId]);
  const contributors = roomContributors(activity ?? []);
  if (!contributors.length) return <span className={`room-avatar empty ${compact ? "compact" : ""}`} role="img" aria-label="No agent activity yet" title="No agent activity yet"><MessagesSquare size={compact ? 18 : 28} aria-hidden="true" /></span>;
  const max = compact ? 22 : 30;
  const step = max + 1;
  const height = contributors.length > 2 ? step * 2 : max;
  const columns = Math.ceil((contributors.length - 1) / 2);
  const width = contributors.length > 1 ? step * (columns + 1) : max;
  const label = contributors.map((a) => `${PROVIDER_INFO[a.provider].name}: ${a.turns} completed turn${a.turns === 1 ? "" : "s"}`).join("; ");
  return <span className={`room-avatar ${compact ? "compact" : ""}`} style={{ width, height }} role="img" aria-label={label} title={`${label}. Icon size reflects completed turns.`}>
    {contributors.map((a, i) => {
      const size = contributionSize(a.turns, contributors[0].turns, compact);
      const x = i === 0 ? 0 : step * (1 + Math.floor((i - 1) / 2));
      const y = i === 0 || contributors.length === 2 ? (height - size) / 2 : ((i - 1) % 2) * step + (max - size) / 2;
      return <span key={a.provider} className="room-agent-icon" data-provider={a.provider} data-turns={a.turns} aria-hidden="true" style={{ width: size, height: size, left: x, top: y, fontSize: Math.max(7, size * 0.38), background: PROVIDER_INFO[a.provider].color }}>{PROVIDER_INFO[a.provider].initials}</span>;
    })}
  </span>;
}
