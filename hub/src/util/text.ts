/**
 * `text` cut to at most `max` UTF-16 units, never through the middle of a character. A plain `slice` can fall between
 * the two halves of an emoji (a surrogate pair); the half left behind isn't valid UTF-8, so SQLite stores it and hands
 * it back as "���" — and the chat is then called "Why the build fails 🚀🚀���" in the list, the header,
 * every notification about it and the Markdown export's file name. The hub takes the same care where it quotes a
 * message (search.ts snippetOf) and where it previews a step (engine.ts previewActivity).
 */
export function cutText(text: string, max: number): string {
  if (text.length <= max) return text;
  // A high surrogate at the cut is the first half of a character: leave it out with its other half.
  return text.slice(0, /[\ud800-\udbff]/.test(text[max - 1]) ? max - 1 : max);
}
