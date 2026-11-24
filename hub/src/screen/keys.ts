// Keys as RFB names them (X11 keysyms), for the agents' typing and key presses.

const NAMED: Record<string, number> = {
  return: 0xff0d, enter: 0xff0d, escape: 0xff1b, esc: 0xff1b, tab: 0xff09, backspace: 0xff08, delete: 0xff08, forwarddelete: 0xffff, del: 0xffff,
  space: 0x20, left: 0xff51, up: 0xff52, right: 0xff53, down: 0xff54, home: 0xff50, end: 0xff57, pageup: 0xff55, pagedown: 0xff56,
  // Modifiers. macOS's Screen Sharing takes Super for Command and Alt for Option.
  shift: 0xffe1, control: 0xffe3, ctrl: 0xffe3, option: 0xffe9, alt: 0xffe9, opt: 0xffe9, command: 0xffeb, cmd: 0xffeb, meta: 0xffeb, super: 0xffeb,
  capslock: 0xffe5,
};
for (let i = 1; i <= 12; i++) NAMED[`f${i}`] = 0xffbe + i - 1;

const MODIFIERS = new Set([0xffe1, 0xffe3, 0xffe9, 0xffeb]);
/** Characters a US keyboard types with Shift held. */
const SHIFTED = '~!@#$%^&*()_+{}|:"<>?';

/** One character's keysym: ASCII and Latin-1 are their own code, anything else is Unicode's. */
export function keysymOf(ch: string): number {
  if (ch === "\n" || ch === "\r") return NAMED.return!;
  if (ch === "\t") return NAMED.tab!;
  const cp = ch.codePointAt(0)!;
  return cp < 0x100 ? cp : 0x01000000 | cp;
}
export const needsShift = (ch: string) => (ch.length === 1 && ch >= "A" && ch <= "Z") || SHIFTED.includes(ch);

/**
 * A key press as an agent writes it ("Return", "cmd+space", "ctrl+shift+a") as keysyms: the modifiers, then the key.
 * Null when it names a key that isn't one.
 */
export function parseCombo(combo: string): { modifiers: number[]; key: number } | null {
  const parts = combo.split("+").map((p) => p.trim()).filter(Boolean);
  if (!parts.length) return null;
  const syms: number[] = [];
  for (const p of parts) {
    const named = NAMED[p.toLowerCase().replace(/[\s_-]/g, "")];
    if (named !== undefined) syms.push(named);
    else if ([...p].length === 1) syms.push(keysymOf(p.toLowerCase()));
    else return null;
  }
  const key = syms.pop()!;
  if (syms.some((s) => !MODIFIERS.has(s))) return null;
  return { modifiers: syms, key };
}
