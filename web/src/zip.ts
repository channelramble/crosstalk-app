/**
 * A minimal ZIP writer (no compression) so a whole folder uploads as one file and the hub unpacks it.
 * Uploading one archive is far more reliable than hundreds of separate requests, and keeps every file name
 * exactly as it is. File contents are referenced as Blob slices, not copied; each file is read once for its CRC.
 */

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(data: Uint8Array, crc = 0xffffffff): number {
  for (let i = 0; i < data.length; i++) crc = CRC_TABLE[(crc ^ data[i]) & 0xff] ^ (crc >>> 8);
  return crc;
}

async function fileCrc(file: Blob): Promise<number> {
  let crc = 0xffffffff;
  const chunk = 8 * 1024 * 1024;
  for (let at = 0; at < file.size; at += chunk) crc = crc32(new Uint8Array(await file.slice(at, at + chunk).arrayBuffer()), crc);
  return (crc ^ 0xffffffff) >>> 0;
}

function dosTime(d: Date): { time: number; date: number } {
  const year = Math.max(1980, d.getFullYear());
  return { time: (d.getHours() << 11) | (d.getMinutes() << 5) | Math.floor(d.getSeconds() / 2), date: ((year - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate() };
}

const MAX32 = 0xffffffff;

/**
 * Builds a ZIP of `entries` (paths use "/"). Switches to ZIP64 records wherever a size, offset or the entry count
 * outgrows classic ZIP (4 GB / 65,535 entries), so there's no size or file-count limit. `zip64` forces it (tests).
 */
export async function makeZip(entries: { file: File; rel: string }[], onProgress?: (done: number) => void, zip64 = false): Promise<Blob> {
  const enc = new TextEncoder();
  const parts: BlobPart[] = [];
  const central: Uint8Array<ArrayBuffer>[] = [];
  let offset = 0;
  for (const [i, { file, rel }] of entries.entries()) {
    const name = enc.encode(rel) as Uint8Array<ArrayBuffer>;
    const crc = await fileCrc(file);
    const { time, date } = dosTime(new Date(file.lastModified || Date.now()));
    const big = zip64 || file.size >= MAX32;
    const farOffset = zip64 || offset >= MAX32;
    // Local header: ZIP64 sizes go in an extra field; the 32-bit fields then hold 0xFFFFFFFF.
    const localExtra = big ? 20 : 0;
    const local = new DataView(new ArrayBuffer(30 + localExtra));
    local.setUint32(0, 0x04034b50, true);
    local.setUint16(4, big ? 45 : 20, true); // version needed
    local.setUint16(6, 0x0800, true); // UTF-8 names
    local.setUint16(8, 0, true); // stored
    local.setUint16(10, time, true);
    local.setUint16(12, date, true);
    local.setUint32(14, crc, true);
    local.setUint32(18, big ? MAX32 : file.size, true);
    local.setUint32(22, big ? MAX32 : file.size, true);
    local.setUint16(26, name.length, true);
    local.setUint16(28, localExtra, true);
    const localHead = new Uint8Array(local.buffer);
    if (big) {
      // The extra field follows the name, so build header + name + extra as one block.
      const block = new Uint8Array(30 + name.length + 20);
      block.set(localHead.subarray(0, 30), 0);
      block.set(name, 30);
      const x = new DataView(block.buffer, 30 + name.length);
      x.setUint16(0, 0x0001, true);
      x.setUint16(2, 16, true);
      x.setBigUint64(4, BigInt(file.size), true);
      x.setBigUint64(12, BigInt(file.size), true);
      parts.push(block, file);
    } else {
      parts.push(localHead, name, file);
    }
    // Central header: only the fields that overflow go in its ZIP64 extra, in the order size, compressed, offset.
    const extraLen = (big ? 16 : 0) + (farOffset ? 8 : 0);
    const entry = new Uint8Array(46 + name.length + (extraLen ? 4 + extraLen : 0));
    const head = new DataView(entry.buffer);
    head.setUint32(0, 0x02014b50, true);
    head.setUint16(4, (3 << 8) | (extraLen ? 45 : 20), true); // made by Unix, so the mode below is honored
    head.setUint16(6, extraLen ? 45 : 20, true);
    head.setUint16(8, 0x0800, true);
    head.setUint16(10, 0, true);
    head.setUint16(12, time, true);
    head.setUint16(14, date, true);
    head.setUint32(16, crc, true);
    head.setUint32(20, big ? MAX32 : file.size, true);
    head.setUint32(24, big ? MAX32 : file.size, true);
    head.setUint16(28, name.length, true);
    head.setUint16(30, extraLen ? 4 + extraLen : 0, true);
    head.setUint32(38, 0o100644 << 16, true); // regular file, never a link
    head.setUint32(42, farOffset ? MAX32 : offset, true);
    entry.set(name, 46);
    if (extraLen) {
      let q = 46 + name.length;
      head.setUint16(q, 0x0001, true);
      head.setUint16(q + 2, extraLen, true);
      q += 4;
      if (big) {
        head.setBigUint64(q, BigInt(file.size), true);
        head.setBigUint64(q + 8, BigInt(file.size), true);
        q += 16;
      }
      if (farOffset) head.setBigUint64(q, BigInt(offset), true);
    }
    central.push(entry);
    offset += 30 + name.length + localExtra + file.size;
    onProgress?.(i + 1);
  }
  const centralSize = central.reduce((n, c) => n + c.length, 0);
  const tail: BlobPart[] = [];
  const needs64 = zip64 || entries.length >= 0xffff || offset >= MAX32 || centralSize >= MAX32;
  if (needs64) {
    // ZIP64 end-of-central-directory record, then its locator.
    const rec = new DataView(new ArrayBuffer(56));
    rec.setUint32(0, 0x06064b50, true);
    rec.setBigUint64(4, 44n, true);
    rec.setUint16(12, 45, true);
    rec.setUint16(14, 45, true);
    rec.setBigUint64(24, BigInt(entries.length), true);
    rec.setBigUint64(32, BigInt(entries.length), true);
    rec.setBigUint64(40, BigInt(centralSize), true);
    rec.setBigUint64(48, BigInt(offset), true);
    const loc = new DataView(new ArrayBuffer(20));
    loc.setUint32(0, 0x07064b50, true);
    loc.setBigUint64(8, BigInt(offset + centralSize), true);
    loc.setUint32(16, 1, true);
    tail.push(rec.buffer, loc.buffer);
  }
  const end = new DataView(new ArrayBuffer(22));
  end.setUint32(0, 0x06054b50, true);
  end.setUint16(8, needs64 ? 0xffff : entries.length, true);
  end.setUint16(10, needs64 ? 0xffff : entries.length, true);
  end.setUint32(12, needs64 ? MAX32 : centralSize, true);
  end.setUint32(16, needs64 ? MAX32 : offset, true);
  return new Blob([...parts, ...central, ...tail, end.buffer], { type: "application/zip" });
}
