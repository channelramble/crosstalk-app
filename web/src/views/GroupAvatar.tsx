import { Users } from "lucide-react";
import type { Member } from "@crosstalk/shared";
import { groupNames } from "../groupChat";
import { ProviderAvatar } from "../ui";

export { groupState } from "../groupChat";

/**
 * A group chat's mark: its first agents' avatars, stacked, the state of the busiest one on the last. Read out as "Group
 * chat: @claude and @codex".
 */
export function GroupAvatar({ members, size, state }: { members: readonly Member[]; size?: "sm" | "lg"; state?: string }) {
  const shown = members.slice(0, size === "sm" ? 2 : 3);
  const label = members.length ? `Group chat: ${groupNames(members)}` : "Group chat";
  return (
    <div className={`avatar-stack group-avatar ${size ?? ""}`} role="img" aria-label={label} title={label}>
      {shown.length ? (
        shown.map((m, i) => <ProviderAvatar key={m.id} provider={m.provider} size={size} state={i === shown.length - 1 ? state : undefined} label={`@${m.handle}`} />)
      ) : (
        <div className={`avatar ${size ?? ""}`} aria-hidden="true">
          <Users size={size === "sm" ? 12 : 16} />
        </div>
      )}
    </div>
  );
}
