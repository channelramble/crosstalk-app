/** Reading a hub terminal's output (views/Terminal.tsx): its text, a code it shows, what's new in it. */

/** Terminal output without its escape codes (colours, cursor moves, OSC 8 links), as it reads. */
export function plainText(s: string): string {
  return s.replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, "").replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, "");
}

/** The last one-time code a sign-in printed to be entered elsewhere: "First copy your one-time code: 7A3F-9B2C" (GitHub). */
export function oneTimeCode(plain: string): string | null {
  return [...plain.matchAll(/one-time code:?\s*([A-Z0-9]{4}-[A-Z0-9]{4})\b/gi)].at(-1)?.[1]?.toUpperCase() ?? null;
}

/**
 * Of `chunks` (output that came live while the whole output `whole` was being fetched, in order), the ones it doesn't
 * end with: they came after it was read, so they're shown after it (the others are in it already).
 */
export function newerThan(whole: string, chunks: string[]): string[] {
  for (let i = chunks.length; i > 0; i--) if (whole.endsWith(chunks.slice(0, i).join(""))) return chunks.slice(i);
  return chunks;
}
