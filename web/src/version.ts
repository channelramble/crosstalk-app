/** Notices when the hub has been updated, so an open page doesn't keep running the old app. */

const BUNDLE = /assets\/index-[\w-]+\.js/;

/** The app bundle this page is running, e.g. "assets/index-CZYLJZtG.js" (null in dev or native builds). */
export function runningBundle(doc: Pick<Document, "querySelectorAll"> = document): string | null {
  for (const s of Array.from(doc.querySelectorAll<HTMLScriptElement>("script[src]"))) {
    const m = s.getAttribute("src")?.match(BUNDLE);
    if (m) return m[0];
  }
  return null;
}

/** The bundle named in an index.html. */
export function bundleIn(html: string): string | null {
  return html.match(BUNDLE)?.[0] ?? null;
}

/** True if the hub now serves a different app than this page loaded. Never throws. */
export async function hubWasUpdated(): Promise<boolean> {
  const mine = runningBundle();
  if (!mine) return false;
  try {
    const res = await fetch(new URL("./", location.href), { cache: "no-store" });
    const theirs = res.ok ? bundleIn(await res.text()) : null;
    return !!theirs && theirs !== mine;
  } catch {
    return false;
  }
}

/** Whether a hub's version is older than this one (false when it isn't known). */
export function olderThan(version: string | undefined, than: string): boolean {
  if (!version) return false;
  const parts = (v: string) => v.split(/[.+-]/).slice(0, 3).map((n) => Number.parseInt(n, 10) || 0);
  const [a, b] = [parts(version), parts(than)];
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] < b[i];
  return false;
}
