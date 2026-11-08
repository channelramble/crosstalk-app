import { createWriteStream, mkdirSync, lstatSync } from "node:fs";
import { dirname, join } from "node:path";
import { crc32, createInflateRaw } from "node:zlib";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { Transform } from "node:stream";

/**
 * A small ZIP reader for uploaded folders. It replaces the system `unzip`, which on macOS garbles UTF-8 names
 * (accents, emoji) and then waits on a keyboard prompt. Supports stored and deflated entries, data descriptors
 * and ZIP64; rejects encrypted entries and links. Nothing is written until the whole archive has been checked.
 */

export interface ZipEntry {
  name: string;
  method: number;
  flags: number;
  crc: number;
  compressedSize: number;
  size: number;
  localOffset: number;
  isDir: boolean;
  isLink: boolean;
}

export class ZipError extends Error {}

// Code page 437, the ZIP default for names without the UTF-8 flag (old Windows tools).
const CP437 =
  "\u0000☺☻♥♦♣♠•◘○◙♂♀♪♫☼►◄↕‼¶§▬↨↑↓→←∟↔▲▼ !\"#$%&'()*+,-./0123456789:;<=>?@ABCDEFGHIJKLMNOPQRSTUVWXYZ[\\]^_`abcdefghijklmnopqrstuvwxyz{|}~⌂" +
  "ÇüéâäàåçêëèïîìÄÅÉæÆôöòûùÿÖÜ¢£¥₧ƒáíóúñÑªº¿⌐¬½¼¡«»░▒▓│┤╡╢╖╕╣║╗╝╜╛┐└┴┬├─┼╞╟╚╔╩╦╠═╬╧╨╤╥╙╘╒╓╫╪┘┌█▄▌▐▀αßΓπΣσµτΦΘΩδ∞φε∩≡±≥≤⌠⌡÷≈°∙·√ⁿ²■\u00a0";
const utf8 = new TextDecoder("utf-8", { fatal: true });

/**
 * Decodes an entry name the way the archive says it was written: UTF-8 when flagged, the Info-ZIP Unicode
 * Path field when present, otherwise UTF-8 if the bytes are valid (macOS and iOS tools skip the flag), else CP437.
 */
function decodeName(raw: Buffer, flags: number, extra: Buffer): string {
  if (flags & 0x0800) {
    try { return utf8.decode(raw); } catch { throw new ZipError("The .zip has a file name that isn't valid UTF-8"); }
  }
  for (let e = 0; e + 4 <= extra.length; ) {
    const id = extra.readUInt16LE(e);
    const len = extra.readUInt16LE(e + 2);
    if (id === 0x7075 && len >= 5 && extra[e + 4] === 1 && extra.readUInt32LE(e + 5) === crc32(raw)) {
      try { return utf8.decode(extra.subarray(e + 9, e + 4 + len)); } catch { /* fall through */ }
    }
    e += 4 + len;
  }
  try { return utf8.decode(raw); } catch { /* not UTF-8: a legacy archive */ }
  return Array.from(raw, (b) => CP437[b]).join("");
}

async function bytes(path: string, start: number, end: number): Promise<Buffer> {
  return Buffer.from(await Bun.file(path).slice(start, end).arrayBuffer());
}

/** Reads the central directory. Throws ZipError if the file isn't a ZIP this reader can handle. */
export async function listZip(path: string): Promise<ZipEntry[]> {
  const fileSize = Bun.file(path).size;
  if (fileSize < 22) throw new ZipError("That file isn't a readable .zip");
  // The end-of-central-directory record sits in the last 22 bytes plus an optional comment (up to 64 KB).
  const tailStart = Math.max(0, fileSize - 22 - 0xffff);
  const tail = await bytes(path, tailStart, fileSize);
  let eocd = -1;
  for (let i = tail.length - 22; i >= 0; i--) if (tail.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  if (eocd < 0) throw new ZipError("That file isn't a readable .zip");
  let count = tail.readUInt16LE(eocd + 10);
  let cdSize = tail.readUInt32LE(eocd + 12);
  let cdOffset = tail.readUInt32LE(eocd + 16);
  // ZIP64: a locator just before the record points at the 64-bit version.
  if ((count === 0xffff || cdSize === 0xffffffff || cdOffset === 0xffffffff) && eocd >= 20 && tail.readUInt32LE(eocd - 20) === 0x07064b50) {
    const z64 = Number(tail.readBigUInt64LE(eocd - 20 + 8));
    const rec = await bytes(path, z64, z64 + 56);
    if (rec.readUInt32LE(0) !== 0x06064b50) throw new ZipError("That .zip is damaged");
    count = Number(rec.readBigUInt64LE(32));
    cdSize = Number(rec.readBigUInt64LE(40));
    cdOffset = Number(rec.readBigUInt64LE(48));
  }
  if (cdOffset + cdSize > fileSize) throw new ZipError("That .zip is damaged or incomplete");
  const cd = await bytes(path, cdOffset, cdOffset + cdSize);
  const entries: ZipEntry[] = [];
  let p = 0;
  for (let i = 0; i < count; i++) {
    if (p + 46 > cd.length || cd.readUInt32LE(p) !== 0x02014b50) throw new ZipError("That .zip is damaged");
    const flags = cd.readUInt16LE(p + 8);
    const method = cd.readUInt16LE(p + 10);
    const crc = cd.readUInt32LE(p + 16);
    let compressedSize = cd.readUInt32LE(p + 20);
    let size = cd.readUInt32LE(p + 24);
    const nameLen = cd.readUInt16LE(p + 28);
    const extraLen = cd.readUInt16LE(p + 30);
    const commentLen = cd.readUInt16LE(p + 32);
    const madeBy = cd.readUInt16LE(p + 4) >> 8;
    const external = cd.readUInt32LE(p + 38);
    let localOffset = cd.readUInt32LE(p + 42);
    const rawName = cd.subarray(p + 46, p + 46 + nameLen);
    const extra = cd.subarray(p + 46 + nameLen, p + 46 + nameLen + extraLen);
    const name = decodeName(rawName, flags, extra);
    for (let e = 0; e + 4 <= extra.length; ) {
      const id = extra.readUInt16LE(e);
      const len = extra.readUInt16LE(e + 2);
      if (id === 0x0001) {
        let q = e + 4;
        if (size === 0xffffffff) { size = Number(extra.readBigUInt64LE(q)); q += 8; }
        if (compressedSize === 0xffffffff) { compressedSize = Number(extra.readBigUInt64LE(q)); q += 8; }
        if (localOffset === 0xffffffff) { localOffset = Number(extra.readBigUInt64LE(q)); q += 8; }
      }
      e += 4 + len;
    }
    const unixMode = madeBy === 3 ? external >>> 16 : 0;
    entries.push({
      name,
      method,
      flags,
      crc,
      compressedSize,
      size,
      localOffset,
      isDir: name.endsWith("/"),
      isLink: (unixMode & 0o170000) === 0o120000,
    });
    p += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

/** Writes one entry's contents to `target`, checking its size and CRC. */
export async function extractEntry(path: string, entry: ZipEntry, target: string): Promise<void> {
  if (entry.flags & 0x1) throw new ZipError(`${entry.name} is encrypted; send an unencrypted .zip`);
  if (entry.method !== 0 && entry.method !== 8) throw new ZipError(`${entry.name} uses an unsupported compression method`);
  const head = await bytes(path, entry.localOffset, entry.localOffset + 30);
  if (head.readUInt32LE(0) !== 0x04034b50) throw new ZipError("That .zip is damaged");
  const dataStart = entry.localOffset + 30 + head.readUInt16LE(26) + head.readUInt16LE(28);
  mkdirSync(dirname(target), { recursive: true });
  const source = Readable.fromWeb(Bun.file(path).slice(dataStart, dataStart + entry.compressedSize).stream() as never);
  let crc = 0;
  let written = 0;
  const check = new Transform({
    transform(chunk: Buffer, _enc, done) {
      written += chunk.length;
      if (written > entry.size) return done(new ZipError(`${entry.name} is larger than the .zip says`));
      crc = crc32(chunk, crc);
      done(null, chunk);
    },
  });
  const out = createWriteStream(target, { flags: "wx", mode: 0o600 });
  if (entry.method === 8) await pipeline(source, createInflateRaw(), check, out);
  else await pipeline(source, check, out);
  if (written !== entry.size || crc >>> 0 !== entry.crc >>> 0) throw new ZipError(`${entry.name} is damaged in the .zip`);
  if (lstatSync(target).isSymbolicLink()) throw new ZipError("Invalid file in .zip");
}

/** Joins a checked ZIP entry name under `root`. */
export function entryPath(root: string, name: string): string {
  return join(root, ...name.split("/").filter(Boolean));
}
