import { idleSignOutAt, type Device } from "@crosstalk/shared";

/** For a device's line: when it will be signed out for saying nothing, once that's a week away or less. */
export function quietSoon(d: Pick<Device, "createdAt" | "lastMessageAt" | "scope"> & Partial<Pick<Device, "hubId" | "platform">>, days: number | null, now = Date.now()): string {
  const at = days ? idleSignOutAt(d, days) : null;
  if (at === null || d.lastMessageAt === undefined) return "";
  const left = Math.ceil((at - now) / 86_400_000);
  if (left > 7) return "";
  return left <= 1 ? " · signs out within a day unless it sends a message" : ` · signs out in ${left} days unless it sends a message`;
}
