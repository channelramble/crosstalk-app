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

/** Whether the card is worth a person's screen: only when there is something to say or to do. */
export const showMemory = (m: MachineMemory | null): m is MachineMemory => !!m && (m.band === "busy" || m.band === "tight" || m.band === "full");

/** Under the heading: how much of the machine the heavy things hold. "10.9 GB of 16.0 GB" */
export function memoryTaken(m: MachineMemory): string | null {
  if (m.takenBytes === null || m.ramBytes <= 0) return null;
  return `${bytesText(m.takenBytes)} of ${bytesText(m.ramBytes)}`;
}

/** Said once, under the list: swap is the slow part, and this is the number that shows it. */
export function memorySwap(m: MachineMemory): string | null {
  if (m.swapUsedBytes === null || m.swapUsedBytes <= 0) return null;
  const moving = m.swapPagesPerSec !== null && m.swapPagesPerSec > 0;
  return `${bytesText(m.swapUsedBytes)} has moved to the disk${moving ? ", and it is still moving" : ""}. That is why everything feels slow.`;
}

/** The whole card in one sentence, for a reader who can't see the list. */
export const memorySummary = (m: MachineMemory, machine: string) => [memoryLine(m, machine), ...memoryWays(m).map((w) => `${w.text}.`)].join(" ");
