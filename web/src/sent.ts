import type { Message } from "@crosstalk/shared";

/**
 * A chat's messages with one you just sent added, as the hub saved it (the answer to sending it). It shows at once,
 * even when its live event never comes (a connection that still looks open after the phone was locked): once, when the
 * event came first, and in its place, newest last.
 */
export function withSent(messages: Message[], sent: Message): Message[] {
  if (messages.some((m) => m.id === sent.id)) return messages;
  // Its place: before the first message that came after it (by the hub's order when both have it, else by time).
  const later = (m: Message) => (typeof m.seq === "number" && typeof sent.seq === "number" ? m.seq > sent.seq : m.createdAt > sent.createdAt);
  const i = messages.findIndex(later);
  return i < 0 ? [...messages, sent] : [...messages.slice(0, i), sent, ...messages.slice(i)];
}
