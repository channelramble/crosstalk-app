/** Link helpers with no browser or store dependencies (unit-tested in links.test.ts). */

/**
 * If a link in a message points at a file path (absolute, file://, or relative like dist/app.zip), returns that
 * path so it can download from the room's project folder. Web links, anchors and Crosstalk's own URLs return null.
 */
export function projectPath(href: string | undefined): string | null {
  if (!href || href.startsWith("#") || href.startsWith("/api/")) return null;
  let h = href;
  if (/^file:\/\//i.test(h)) h = h.replace(/^file:\/\/(localhost)?/i, "");
  else if (/^[a-z][a-z0-9+.-]*:/i.test(h) || h.startsWith("//")) return null; // https:, mailto:, …
  // Drop a query or fragment first: after decoding, %23 and %3F are real "#" and "?" in the file name.
  h = h.split(/[?#]/)[0];
  try { h = decodeURIComponent(h); } catch { /* keep as written */ }
  return h || null;
}

/**
 * Markdown URL filter: keeps file:// links (they become project downloads) and otherwise applies react-markdown's
 * default, which drops unsafe schemes like javascript:.
 */
export function urlTransform(url: string, fallback: (url: string) => string): string {
  return /^file:\/\//i.test(url) ? url : fallback(url);
}
