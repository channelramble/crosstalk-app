import { normalizeMode, parseMentions, type Member, type Room } from "@crosstalk/shared";

// Keep the existing direct wire value for Off, so older clients can still read rooms.
// Legacy modes are mapped to Off during the shared/hub migration as well.
export type TeamworkMode = "review" | "direct";
export const TEAMWORK_OPTIONS: { id: TeamworkMode; label: string; help: string }[] = [
  { id: "review", label: "Build & review", help: "Your default agent does the work. Another agent checks it, and they improve it together until approved or the round limit is reached." },
  { id: "direct", label: "Off", help: "Your default agent handles the request. Mention another agent to choose who answers. No automatic back-and-forth." },
];
export const teamworkMode = normalizeMode;
export const teamworkLabel = (mode: string): string => mode === "review" ? "Build & review" : "Off";
export function parallelWorkHelp(enabled: boolean, mode: string): string {
  if (!enabled) return "One agent works at a time.";
  return "When you involve multiple agents, they may work at the same time. They are asked to divide file ownership and check each other's changes." + (mode === "review" ? " Build & review still passes work back and forth." : "");
}

/** Match the hub's mention resolution, including @everyone and mixed-case handles. */
export function messageRecipients(text: string, members: Member[]): Member[] {
  const handles = parseMentions(text);
  if (handles.includes("all") || handles.includes("everyone")) return members;
  return handles.map((h) => members.find((m) => m.handle.toLowerCase() === h)).filter((m): m is Member => !!m);
}

export function recipientPreview(room: Room, members: Member[], text: string): string | null {
  if (!members.length) return null;
  const mentioned = messageRecipients(text, members);
  if (mentioned.length) return mentioned.map((m) => `@${m.handle}`).join(", ");
  const lead = members.find((m) => m.id === room.leadMemberId) ?? members[0];
  if (room.mode !== "review") return `@${lead.handle}`;
  const reviewer = members.find((m) => m.id !== lead.id);
  return `@${lead.handle} builds${reviewer ? ` · @${reviewer.handle} reviews` : " · add a reviewer in Team"}`;
}
