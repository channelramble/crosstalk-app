/** How a code block in a message shows (ui.tsx draws it). */

/** Blocks of up to this many lines show whole. */
export const OPEN_UP_TO = 12;
/** A longer block shows its first this many lines, fading out, with "Show all N lines". */
export const PREVIEW_LINES = 8;

export interface CodeBlockView {
  /** Every line shows (else the first PREVIEW_LINES, fading out). */
  whole: boolean;
  /** "Show all N lines" under the preview. */
  showAll: boolean;
  /** "Collapse" at the end of a long block that's open. */
  collapse: boolean;
}

/**
 * Blocks of up to 12 lines show whole, longer ones their first 8 lines with "Show all N lines" (and Collapse at the end
 * once open). A tap (`tapped`: opened or collapsed, null before any) wins over that, so a block keeps the way it was
 * tapped while its reply streams more lines into it.
 */
export function codeBlockView(lines: number, tapped: boolean | null): CodeBlockView {
  const long = lines > OPEN_UP_TO;
  const open = tapped ?? !long;
  // Nothing to hide in a block no longer than the preview.
  const whole = open || lines <= PREVIEW_LINES;
  return { whole, showAll: !whole, collapse: open && long };
}
