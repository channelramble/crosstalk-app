import type { MachineMemory, MemoryBand } from "@crosstalk/shared";
import { bytesText, memoryLine, memoryWays } from "@crosstalk/shared";

// What Settings → Memory says (views/MemorySection.tsx). The sentences themselves live in shared, because the hub
// writes the same ones into its refusals and its notification, and two sets of words would drift apart.

export { memoryLine, memoryWays } from "@crosstalk/shared";

/** The pill beside the heading, and its colour. Nothing is shown at all while memory is fine. */
export const MEMORY_PILL: Record<MemoryBand, { label: string; tone: "" | "orange" | "red" } | null> = {
  fine: { label: "Fine", tone: "" },
  busy: { label: "Getting full", tone: "orange" },
  tight: { label: "Nearly full", tone: "orange" },
  full: { label: "Full", tone: "red" },
  unknown: null,
};

/** Whether the card has something to say about the machine: only while it is getting full. */
export const showMemory = (m: MachineMemory | null): m is MachineMemory => !!m && (m.band === "busy" || m.band === "tight" || m.band === "full");

/**
 * Whether the card has its switch ("Free memory by itself"): on a machine that says whether it acts (older ones never
 * do) and can read its memory. That switch is why the card is there while memory is fine, too.
 */
export const hasMemorySwitch = (m: MachineMemory | null): m is MachineMemory => !!m && m.acts !== undefined && m.band !== "unknown";

/** Under the list: how much of the machine what is listed holds. "10.9 GB of 16.0 GB" */
export function memoryTaken(m: MachineMemory): string | null {
  // A newer machine lists agents, their browser and your own programs too, which `takenBytes` leaves out (it is what
  // the next model has to fit beside): the sentence is about the list above it, so it adds up the list.
  const listed = m.holders.some((h) => h.kind) ? m.holders.reduce((n, h) => n + (h.bytes ?? 0), 0) || null : m.takenBytes;
  if (listed === null || m.ramBytes <= 0) return null;
  return `${bytesText(listed)} of ${bytesText(m.ramBytes)}`;
}

/** The one sentence under the switch. */
export const memoryActHelp = (machine: string) =>
  `When ${machine} is about to run out of memory, Crosstalk asks the agent that is filling it to close its pages, and stops that reply if it keeps growing.`;

/** The card's last line: what Crosstalk will and won't stop, which depends on the switch. */
export const memoryPromise = (m: MachineMemory) =>
  m.acts ? "Crosstalk never stops anything you started yourself." : "Crosstalk never stops anything by itself, and never anything you started.";

/** Said once, under the list: swap is the slow part, and this is the number that shows it. */
export function memorySwap(m: MachineMemory): string | null {
  if (m.swapUsedBytes === null || m.swapUsedBytes <= 0) return null;
  const moving = m.swapPagesPerSec !== null && m.swapPagesPerSec > 0;
  return `${bytesText(m.swapUsedBytes)} has moved to the disk${moving ? ", and it is still moving" : ""}. That is why everything feels slow.`;
}

/** The whole card in one sentence, for a reader who can't see the list. */
export const memorySummary = (m: MachineMemory, machine: string) => [memoryLine(m, machine), ...memoryWays(m).map((w) => `${w.text}.`)].join(" ");
