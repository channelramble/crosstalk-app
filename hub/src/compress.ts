// Smaller answers for the app. Its own files (1.6 MB of script and styles) and the bigger JSON answers (a chat's
// history) went out uncompressed, on every first load, every update and every chat opened over a phone's connection.
// Text compresses to about a quarter. The app's files are compressed once and kept (they never change while the hub
// runs); an API answer is compressed as it goes, only when it's big enough to be worth it.

import { brotliCompressSync, constants, gzipSync } from "node:zlib";

/** File endings worth compressing: text. Pictures and fonts already are. */
const TEXT = /\.(html|js|css|json|svg|txt|webmanifest|map)$/;
/** Smaller than this, the header costs about what's saved. */
const MIN_BYTES = 1024;

export type Encoding = "br" | "gzip";

/** What a request says it can take, best first. Brotli only over HTTPS-era clients that ask for it; gzip otherwise. */
export function pickEncoding(acceptEncoding: string | null | undefined): Encoding | null {
  const a = (acceptEncoding ?? "").toLowerCase();
  if (/\bbr\b/.test(a)) return "br";
  if (/\bgzip\b/.test(a)) return "gzip";
  return null;
}

export const compressible = (path: string) => TEXT.test(path);

function pack(bytes: Uint8Array, enc: Encoding, quality: number): Uint8Array {
  return enc === "br" ? new Uint8Array(brotliCompressSync(bytes, { params: { [constants.BROTLI_PARAM_QUALITY]: quality, [constants.BROTLI_PARAM_SIZE_HINT]: bytes.length } })) : new Uint8Array(gzipSync(bytes, { level: 6 }));
}

/** The app's files, compressed once each (by path and encoding). They're the same for as long as the hub runs. */
const kept = new Map<string, Uint8Array>();

/**
 * One of the app's files as the request can take it: the compressed bytes and their encoding, or null when it isn't
 * text, is tiny, or the request takes neither. `key` names the file's version (its path is enough for embedded files;
 * a file on disk adds its size and time, so an edited one is compressed again).
 */
export async function compressedFile(key: string, path: string, read: () => Promise<Uint8Array>, acceptEncoding: string | null): Promise<{ bytes: Uint8Array; encoding: Encoding } | null> {
  const encoding = pickEncoding(acceptEncoding);
  if (!encoding || !compressible(path)) return null;
  const k = `${encoding}:${key}`;
  let bytes = kept.get(k);
  if (!bytes) {
    const raw = await read();
    if (raw.length < MIN_BYTES) return null;
    // Once per file: worth the best ratio that still takes well under a second for a megabyte.
    bytes = pack(raw, encoding, 8);
    kept.set(k, bytes);
  }
  return { bytes, encoding };
}

/** A JSON answer as the request can take it: compressed when it's big enough, quickly (it's made on every request). */
export function compressedJson(text: string, acceptEncoding: string | null): { body: Uint8Array; encoding: Encoding } | null {
  const encoding = pickEncoding(acceptEncoding);
  if (!encoding || text.length < 4 * MIN_BYTES) return null;
  const raw = new TextEncoder().encode(text);
  return { body: pack(raw, encoding, 4), encoding };
}
