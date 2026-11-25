// The Content-Security-Policy the app's page is served with. Nothing in the app injects script today (a reply's
// Markdown is drawn as text, links are checked), but the page holds this device's sign-in for every machine it's paired
// with, so a mistake anywhere would cost all of them. With this policy a script that isn't the app's own doesn't run:
// - script only from the app's own files, plus the one small inline script in index.html that puts the saved theme on
//   the page before the first paint (allowed by its hash, worked out from the page as it's served);
// - styles from the app's files and inline `style` attributes (React sets them, and the terminal writes its own);
// - pictures, sounds and fonts from the app, from data: and from blob: (attachments are fetched with the sign-in and
//   shown from memory; the pairing QR is a data: picture);
// - connections anywhere over http(s) and ws(s): the app talks to the person's other machines at their own addresses;
// - no frames, no plugins, no <base>, no forms posted anywhere, and nobody may frame the app.

const sha256 = (text: string) => new Bun.CryptoHasher("sha256").update(text).digest("base64");

/** The inline scripts of a page (those with no `src`), as written between their tags. */
export function inlineScripts(html: string): string[] {
  const out: string[] = [];
  for (const m of html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)) {
    if (!/\bsrc\s*=/i.test(m[1]) && m[2].trim()) out.push(m[2]);
  }
  return out;
}

/** The policy for a page: `html` is the page itself, whose inline scripts are allowed by hash. */
export function contentPolicy(html: string): string {
  const hashes = inlineScripts(html).map((s) => `'sha256-${sha256(s)}'`);
  return [
    "default-src 'self'",
    ["script-src 'self'", ...hashes].join(" "),
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "media-src 'self' data: blob:",
    "font-src 'self' data:",
    "connect-src 'self' https: wss: http: ws:",
    "worker-src 'self'",
    "manifest-src 'self'",
    "frame-src 'none'",
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'none'",
    "frame-ancestors 'none'",
  ].join("; ");
}

const cache = new Map<string, string>();
/** The policy for the page behind `key` (a file's identity: it changes when the file does), read once. */
export async function policyFor(key: string, page: Blob): Promise<string> {
  let policy = cache.get(key);
  if (!policy) {
    policy = contentPolicy(await page.text());
    if (cache.size > 8) cache.clear();
    cache.set(key, policy);
  }
  return policy;
}
