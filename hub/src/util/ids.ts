const ALPHABET = "0123456789abcdefghjkmnpqrstvwxyz";

export function newId(prefix: string, len = 12): string {
  const bytes = crypto.getRandomValues(new Uint8Array(len));
  let s = "";
  for (const b of bytes) s += ALPHABET[b & 31];
  return `${prefix}_${s}`;
}

/** Human-friendly one-time code, e.g. "K7QM-2XPA". Avoids look-alike characters. */
export function pairingCode(): string {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  const bytes = crypto.getRandomValues(new Uint8Array(8));
  let s = "";
  bytes.forEach((b, i) => {
    s += chars[b % chars.length];
    if (i === 3) s += "-";
  });
  return s;
}

export function secretToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return Buffer.from(bytes).toString("base64url");
}

export async function sha256(s: string): Promise<string> {
  const h = new Bun.CryptoHasher("sha256");
  h.update(s);
  return h.digest("hex");
}
