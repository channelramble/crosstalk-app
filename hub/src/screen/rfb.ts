// The remote framebuffer protocol (RFB, what VNC speaks), as much of it as Crosstalk needs to see and drive the hub
// machine's own screen: on a Mac that is macOS's Screen Sharing on 127.0.0.1:5900, whose input counts as a person's (it
// can answer the prompts that ignore software clicks). Two users: RfbClient keeps a copy of the screen for the agents'
// tools (screen/index.ts), and `rfbOpen` signs in for the phone's live view, whose bytes are then passed straight through
// (screen/proxy.ts). Nothing here stores a password: callers hand it in.

import { createCipheriv, createDiffieHellman, createHash, randomBytes } from "node:crypto";
import type { Socket } from "bun";

/** What signs in: a VNC password (Screen Sharing's "VNC viewers may control screen with password"), or a Mac account. */
export interface RfbCredentials {
  password?: string;
  username?: string;
}

/** Why a connection didn't happen, in words the person can act on; `code` says which kind. */
export class RfbError extends Error {
  constructor(
    message: string,
    public code: "off" | "auth" | "refused" | "protocol" | "closed",
  ) {
    super(message);
  }
}

/** Bytes as they come in, read in exact amounts. */
export class ByteReader {
  private chunks: Uint8Array[] = [];
  private have = 0;
  private waiter: { need: number; resolve: (b: Uint8Array) => void; reject: (e: Error) => void } | null = null;
  private ended: Error | null = null;

  push(chunk: Uint8Array) {
    if (!chunk.length) return;
    // Bun reuses the buffer it hands to `data`: keep a copy.
    this.chunks.push(chunk.slice());
    this.have += chunk.length;
    this.pump();
  }
  end(err: Error) {
    this.ended = err;
    const w = this.waiter;
    this.waiter = null;
    w?.reject(err);
  }
  /** Everything not yet read (for handing a connection over to a pipe). */
  rest(): Uint8Array {
    const out = this.take(this.have);
    return out;
  }
  read(n: number): Promise<Uint8Array> {
    if (n === 0) return Promise.resolve(new Uint8Array(0));
    if (this.have >= n) return Promise.resolve(this.take(n));
    if (this.ended) return Promise.reject(this.ended);
    return new Promise((resolve, reject) => {
      this.waiter = { need: n, resolve, reject };
    });
  }
  private pump() {
    const w = this.waiter;
    if (w && this.have >= w.need) {
      this.waiter = null;
      w.resolve(this.take(w.need));
    }
  }
  private take(n: number): Uint8Array {
    const out = new Uint8Array(n);
    let at = 0;
    while (at < n) {
      const c = this.chunks[0]!;
      const want = n - at;
      if (c.length <= want) {
        out.set(c, at);
        at += c.length;
        this.chunks.shift();
      } else {
        out.set(c.subarray(0, want), at);
        this.chunks[0] = c.subarray(want);
        at += want;
      }
    }
    this.have -= n;
    return out;
  }
}

const u16 = (b: Uint8Array, at = 0) => (b[at]! << 8) | b[at + 1]!;
const u32 = (b: Uint8Array, at = 0) => ((b[at]! << 24) | (b[at + 1]! << 16) | (b[at + 2]! << 8) | b[at + 3]!) >>> 0;
const i32 = (b: Uint8Array, at = 0) => (b[at]! << 24) | (b[at + 1]! << 16) | (b[at + 2]! << 8) | b[at + 3]!;
const text = (b: Uint8Array) => new TextDecoder().decode(b);

/** VNC authentication's answer: the 16-byte challenge under DES, keyed by the password with each byte's bits reversed. */
export function vncResponse(challenge: Uint8Array, password: string): Uint8Array {
  const key = Buffer.alloc(8);
  Buffer.from(password, "latin1").copy(key, 0, 0, 8);
  for (let i = 0; i < 8; i++) {
    let b = key[i]!;
    let r = 0;
    for (let bit = 0; bit < 8; bit++) {
      r = (r << 1) | (b & 1);
      b >>= 1;
    }
    key[i] = r;
  }
  const des = createCipheriv("des-ecb", key, null);
  des.setAutoPadding(false);
  return new Uint8Array(Buffer.concat([des.update(challenge), des.final()]));
}

/** Apple Remote Desktop's sign-in (security type 30): a Mac account's name and password under a Diffie-Hellman key. */
function ardResponse(generator: number, prime: Uint8Array, serverKey: Uint8Array, creds: Required<RfbCredentials>): Uint8Array {
  const len = prime.length;
  const dh = createDiffieHellman(Buffer.from(prime), Buffer.from([generator >> 8, generator & 0xff]));
  dh.generateKeys();
  const pad = (b: Buffer) => (b.length >= len ? b.subarray(b.length - len) : Buffer.concat([Buffer.alloc(len - b.length), b]));
  const secret = pad(dh.computeSecret(Buffer.from(serverKey)));
  const key = createHash("md5").update(secret).digest();
  // Name and password, each in 64 bytes, ended by a zero, the rest random.
  const plain = randomBytes(128);
  const name = Buffer.from(creds.username, "utf8").subarray(0, 63);
  const pass = Buffer.from(creds.password, "utf8").subarray(0, 63);
  name.copy(plain, 0);
  plain[name.length] = 0;
  pass.copy(plain, 64);
  plain[64 + pass.length] = 0;
  const aes = createCipheriv("aes-128-ecb", key, null);
  aes.setAutoPadding(false);
  return new Uint8Array(Buffer.concat([aes.update(plain), aes.final(), pad(dh.getPublicKey())]));
}

export interface RfbServerInit {
  width: number;
  height: number;
  /** The 16 bytes of the server's own pixel format, as it sent them. */
  pixelFormat: Uint8Array;
  name: string;
  /** The whole ServerInit message, to hand to a viewer as it is. */
  raw: Uint8Array;
}

/**
 * Signs in to an RFB server as a client would, up to and including ServerInit. `write` sends bytes to the server.
 * The server may be one that needs no sign-in (a test's, or a VNC server set up that way).
 */
export async function rfbSignIn(reader: ByteReader, write: (b: Uint8Array) => void, creds: RfbCredentials): Promise<RfbServerInit> {
  const hello = text(await reader.read(12));
  if (!/^RFB \d{3}\.\d{3}\n$/.test(hello)) throw new RfbError("What answered on the screen's port isn't a screen-sharing server.", "protocol");
  write(new TextEncoder().encode("RFB 003.008\n"));
  const count = (await reader.read(1))[0]!;
  if (count === 0) {
    const why = text(await reader.read(u32(await reader.read(4))));
    throw new RfbError(`Screen sharing refused the connection: ${why}`, "refused");
  }
  const types = [...(await reader.read(count))];
  const has = (t: number) => types.includes(t);
  let chosen: number;
  if (has(1)) chosen = 1;
  else if (creds.password && !creds.username && has(2)) chosen = 2;
  else if (creds.password && creds.username && has(30)) chosen = 30;
  else if (creds.password && has(2)) chosen = 2;
  else if (!creds.password) throw new RfbError("Screen sharing wants a password, and Crosstalk hasn't been given one yet.", "auth");
  // Only a Mac's Screen Sharing offers sign-in with an account (30): what to change is in its settings. Any other VNC
  // server (Linux) that offers neither is set to sign-ins Crosstalk doesn't know (TLS or a system account, say).
  else if (!has(2) && !creds.username && has(30)) throw new RfbError('Screen Sharing isn\'t set to take a VNC password. In its settings on the Mac, turn on "VNC viewers may control screen with password", or give Crosstalk a Mac account instead.', "auth");
  else throw new RfbError("Screen sharing offers no way of signing in that Crosstalk knows. Set this machine's VNC server to take a VNC password (its \"VncAuth\" security type), then try again.", "auth");
  write(new Uint8Array([chosen]));
  if (chosen === 2) {
    write(vncResponse(await reader.read(16), creds.password!));
  } else if (chosen === 30) {
    const head = await reader.read(4);
    const generator = u16(head, 0);
    const len = u16(head, 2);
    const prime = await reader.read(len);
    const serverKey = await reader.read(len);
    write(ardResponse(generator, prime, serverKey, { username: creds.username!, password: creds.password! }));
  }
  // RFB 3.8 answers every sign-in, even "none".
  const result = u32(await reader.read(4));
  if (result !== 0) {
    let why = "";
    try {
      why = text(await reader.read(Math.min(u32(await reader.read(4)), 400)));
    } catch {
      // some servers just hang up
    }
    throw new RfbError(result === 2 ? "Screen sharing has locked sign-ins for a while after too many wrong passwords. Try again in a few minutes." : `Screen sharing didn't accept the password.${why ? ` (${why.trim()})` : ""}`, "auth");
  }
  write(new Uint8Array([1])); // ClientInit: share the screen with whoever else is looking
  const head = await reader.read(24);
  const nameBytes = await reader.read(u32(head, 20));
  const raw = new Uint8Array(24 + nameBytes.length);
  raw.set(head, 0);
  raw.set(nameBytes, 24);
  return { width: u16(head, 0), height: u16(head, 2), pixelFormat: head.slice(4, 20), name: text(nameBytes), raw };
}

export interface RfbConnection {
  socket: Socket<undefined>;
  reader: ByteReader;
  init: RfbServerInit;
  /** Called with every chunk that arrives after `takeOver`; and once when the connection ends. */
  takeOver(onData: (b: Uint8Array) => void, onClose: () => void): void;
  close(): void;
}

/** Connects to an RFB server and signs in. The caller gets the socket with ServerInit already read. */
export async function rfbOpen(host: string, port: number, creds: RfbCredentials, timeoutMs = 10_000): Promise<RfbConnection> {
  const reader = new ByteReader();
  let forward: ((b: Uint8Array) => void) | null = null;
  let closed: (() => void) | null = null;
  let done = false;
  const end = (why: string) => {
    if (done) return;
    done = true;
    reader.end(new RfbError(why, "closed"));
    closed?.();
  };
  let socket: Socket<undefined>;
  try {
    socket = await Bun.connect({
      hostname: host,
      port,
      socket: {
        data(_s, chunk) {
          if (forward) forward(new Uint8Array(chunk));
          else reader.push(chunk);
        },
        close() {
          end("The screen connection closed.");
        },
        error(_s, e) {
          end(`The screen connection failed: ${e.message}`);
        },
        end() {
          end("The screen connection closed.");
        },
      },
    });
  } catch {
    throw new RfbError("Nothing is sharing this machine's screen yet.", "off");
  }
  const write = (b: Uint8Array) => void socket.write(b);
  const timer = setTimeout(() => {
    reader.end(new RfbError("Screen sharing didn't answer in time.", "closed"));
    socket.end();
  }, timeoutMs);
  try {
    const init = await rfbSignIn(reader, write, creds);
    return {
      socket,
      reader,
      init,
      takeOver(onData, onClose) {
        closed = onClose;
        const rest = reader.rest();
        forward = onData;
        if (rest.length) onData(rest);
        if (done) onClose();
      },
      close() {
        done = true;
        socket.end();
      },
    };
  } catch (e) {
    socket.end();
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

/** The mouse buttons a pointer event carries. */
export const BUTTON = { left: 1, middle: 2, right: 4, wheelUp: 8, wheelDown: 16, wheelLeft: 32, wheelRight: 64 } as const;

/**
 * A client that keeps a copy of the screen: red, green, blue and a spare byte per pixel, rows top to bottom. It asks only
 * for the plainest encodings (raw pixels and "this part moved"), which every server has; on the same machine that costs
 * nothing worth saving.
 */
export class RfbClient {
  width = 0;
  height = 0;
  pixels = new Uint8Array(0);
  /** Counts framebuffer updates, so a caller can tell the screen has been drawn since it asked. */
  updates = 0;
  lastUpdateAt = 0;
  closed = false;
  private conn: RfbConnection | null = null;
  private onChange: (() => void)[] = [];

  static async connect(host: string, port: number, creds: RfbCredentials): Promise<RfbClient> {
    const c = new RfbClient();
    c.conn = await rfbOpen(host, port, creds);
    c.resize(c.conn.init.width, c.conn.init.height);
    // 32 bits a pixel, little-endian, red in the lowest byte: the bytes arrive as R, G, B, spare.
    const fmt = new Uint8Array([0, 0, 0, 0, 32, 24, 0, 1, 0, 255, 0, 255, 0, 255, 0, 8, 16, 0, 0, 0]);
    c.send(fmt);
    const encodings = [0, 1, -223]; // raw, copy-rect, and "the screen changed size"
    const enc = new Uint8Array(4 + encodings.length * 4);
    enc[0] = 2;
    enc[3] = encodings.length;
    encodings.forEach((e, i) => new DataView(enc.buffer).setInt32(4 + i * 4, e));
    c.send(enc);
    c.request(false);
    void c.loop();
    return c;
  }

  private send(b: Uint8Array) {
    if (!this.closed) this.conn?.socket.write(b);
  }
  private resize(w: number, h: number) {
    this.width = w;
    this.height = h;
    this.pixels = new Uint8Array(w * h * 4);
  }
  private request(incremental: boolean) {
    const m = new Uint8Array(10);
    m[0] = 3;
    m[1] = incremental ? 1 : 0;
    new DataView(m.buffer).setUint16(6, this.width);
    new DataView(m.buffer).setUint16(8, this.height);
    this.send(m);
  }

  private async loop() {
    const r = this.conn!.reader;
    try {
      for (;;) {
        const type = (await r.read(1))[0]!;
        if (type === 0) {
          const head = await r.read(3);
          const rects = u16(head, 1);
          for (let i = 0; i < rects; i++) {
            const rh = await r.read(12);
            const x = u16(rh, 0), y = u16(rh, 2), w = u16(rh, 4), h = u16(rh, 6);
            const encoding = i32(rh, 8);
            if (encoding === 0) {
              const data = await r.read(w * h * 4);
              if (x + w <= this.width && y + h <= this.height) for (let row = 0; row < h; row++) this.pixels.set(data.subarray(row * w * 4, (row + 1) * w * 4), ((y + row) * this.width + x) * 4);
            } else if (encoding === 1) {
              const src = await r.read(4);
              const sx = u16(src, 0), sy = u16(src, 2);
              if (sx + w <= this.width && sy + h <= this.height && x + w <= this.width && y + h <= this.height) {
                const copy = new Uint8Array(w * h * 4);
                for (let row = 0; row < h; row++) copy.set(this.pixels.subarray(((sy + row) * this.width + sx) * 4, ((sy + row) * this.width + sx + w) * 4), row * w * 4);
                for (let row = 0; row < h; row++) this.pixels.set(copy.subarray(row * w * 4, (row + 1) * w * 4), ((y + row) * this.width + x) * 4);
              }
            } else if (encoding === -223) {
              this.resize(w, h);
            } else {
              throw new RfbError(`The screen sent a kind of picture Crosstalk didn't ask for (${encoding}).`, "protocol");
            }
          }
          this.updates++;
          this.lastUpdateAt = Date.now();
          for (const f of this.onChange.splice(0)) f();
          this.request(true);
        } else if (type === 1) {
          const head = await r.read(5);
          await r.read(u16(head, 3) * 6);
        } else if (type === 2) {
          // bell
        } else if (type === 3) {
          const head = await r.read(7);
          await r.read(u32(head, 3));
        } else {
          throw new RfbError(`The screen sent a message Crosstalk doesn't know (${type}).`, "protocol");
        }
      }
    } catch {
      this.close();
    }
  }

  /** Resolves at the next screen update, or after `ms` without one. */
  nextUpdate(ms: number): Promise<void> {
    return new Promise((resolve) => {
      const t = setTimeout(resolve, ms);
      this.onChange.push(() => {
        clearTimeout(t);
        resolve();
      });
    });
  }
  /** Waits until the screen has stopped changing for `quietMs` (or `maxMs` has passed): after a click, say. */
  async settle(quietMs = 250, maxMs = 2500): Promise<void> {
    const end = Date.now() + maxMs;
    for (;;) {
      const before = this.updates;
      await this.nextUpdate(quietMs);
      if (this.updates === before || Date.now() >= end || this.closed) return;
    }
  }

  pointer(x: number, y: number, buttons = 0) {
    const m = new Uint8Array(6);
    m[0] = 5;
    m[1] = buttons;
    new DataView(m.buffer).setUint16(2, Math.max(0, Math.min(this.width - 1, Math.round(x))));
    new DataView(m.buffer).setUint16(4, Math.max(0, Math.min(this.height - 1, Math.round(y))));
    this.send(m);
  }
  key(keysym: number, down: boolean) {
    const m = new Uint8Array(8);
    m[0] = 4;
    m[1] = down ? 1 : 0;
    new DataView(m.buffer).setUint32(4, keysym >>> 0);
    this.send(m);
  }
  close() {
    if (this.closed) return;
    this.closed = true;
    this.conn?.close();
    for (const f of this.onChange.splice(0)) f();
  }
}
