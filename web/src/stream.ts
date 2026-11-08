export type TextDelta = { offset: number; delta: string };

/** Offsets are JS string positions, matching the hub. Overlapping snapshots never duplicate text. */
export function mergeTextDelta(text: string, chunk: TextDelta): string | null {
  const { offset, delta } = chunk;
  if (!Number.isSafeInteger(offset) || offset < 0 || offset > text.length) return null;
  const overlap = Math.min(text.length - offset, delta.length);
  if (text.slice(offset, offset + overlap) !== delta.slice(0, overlap)) return null;
  return text + delta.slice(overlap);
}
