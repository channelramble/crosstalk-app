// A screen-sharing server for tests: RFB 3.8 with VNC authentication (or none), and a Mac account's sign-in as macOS's
// Screen Sharing takes it (`account`: security type 30, offered before the VNC password), a framebuffer the test paints, and a
// record of every key and pointer event it was sent. It sends the screen raw, which is all the hub asks for.

import { createCipheriv, createDecipheriv, createDiffieHellman, createHash } from "node:crypto";
import type { Socket, TCPSocketListener } from "bun";

export interface FakeVnc {
  port: number;
  width: number;
  height: number;
  /** Pointer and key events received, in order. */
  events: ({ t: "pointer"; x: number; y: number; buttons: number } | { t: "key"; sym: number; down: boolean })[];
  /** Paints a rectangle (red, green, blue 0-255) and sends it to whoever asked for updates. */
  paint(x: number, y: number, w: number, h: number, rgb: [number, number, number]): void;
  /** How many clients are connected. */
  clients(): number;
  /** Sign-ins refused for a wrong password. */
  refused: number;
  /** How each accepted sign-in was made, in order: an account's name, or "vnc" for the VNC password, "none" for none. */
  signIns: string[];
  stop(): void;
}

/** A standard 1024-bit prime (RFC 2409's second group), as long as the one macOS uses. */
const DH_PRIME = Buffer.from(
  "FFFFFFFFFFFFFFFFC90FDAA22168C234C4C6628B80DC1CD129024E088A67CC74020BBEA63B139B22514A08798E3404DDEF9519B3CD3A431B302B0A6DF25F14374FE1356D6D51C245E485B576625E7EC6F44C42E9A637ED6B0BFF5CB6F406B7EDEE386BFB5A899FA5AE9F24117C4B1FE649286651ECE65381FFFFFFFFFFFFFFFF",
  "hex",
);

function desKey(password: string): Buffer {
  const key = Buffer.alloc(8);
  Buffer.from(password, "latin1").copy(key, 0, 0, 8);
  for (let i = 0; i < 8; i++) {
    let b = key[i]!, r = 0;
    for (let bit = 0; bit < 8; bit++) {
      r = (r << 1) | (b & 1);
      b >>= 1;
    }
    key[i] = r;
  }
  return key;
}

interface Client {
  buf: Buffer;
  stage: "version" | "security" | "auth" | "ard" | "init" | "run";
  dh?: ReturnType<typeof createDiffieHellman>;
  challenge: Buffer;
  wantsUpdate: boolean;
  /** Something was painted while it wasn't asking: it gets the screen at its next request, as a real server does. */
  dirty: boolean;
  /** Bytes the socket hasn't taken yet (a big picture goes out in parts). */
  out: Buffer[];
  /** Byte offsets of red, green and blue in each pixel the client asked for. */
  shifts: [number, number, number];
}

export function fakeVnc(opts: { password?: string; account?: { name: string; password: string }; width?: number; height?: number; offers?: number[] } = {}): FakeVnc {
  const width = opts.width ?? 64, height = opts.height ?? 48;
  const fb = new Uint8Array(width * height * 3).fill(40);
  const clients = new Map<Socket<Client>, Client>();
  const out: FakeVnc = {
    port: 0,
    width,
    height,
    events: [],
    refused: 0,
    signIns: [],
    paint(x, y, w, h, rgb) {
      for (let yy = y; yy < y + h; yy++) for (let xx = x; xx < x + w; xx++) fb.set(rgb, (yy * width + xx) * 3);
      for (const [s, c] of clients) {
        if (c.stage !== "run") continue;
        if (c.wantsUpdate) sendRect(s, c, x, y, w, h);
        else c.dirty = true;
      }
    },
    clients: () => [...clients.values()].filter((c) => c.stage === "run").length,
    stop: () => server.stop(true),
  };
  const sendRect = (s: Socket<Client>, c: Client, x: number, y: number, w: number, h: number) => {
    const msg = Buffer.alloc(4 + 12 + w * h * 4);
    msg.writeUInt16BE(1, 2);
    msg.writeUInt16BE(x, 4);
    msg.writeUInt16BE(y, 6);
    msg.writeUInt16BE(w, 8);
    msg.writeUInt16BE(h, 10);
    msg.writeInt32BE(0, 12);
    let at = 16;
    for (let yy = y; yy < y + h; yy++)
      for (let xx = x; xx < x + w; xx++) {
        const p = (yy * width + xx) * 3;
        msg[at + c.shifts[0] / 8] = fb[p]!;
        msg[at + c.shifts[1] / 8] = fb[p + 1]!;
        msg[at + c.shifts[2] / 8] = fb[p + 2]!;
        at += 4;
      }
    c.wantsUpdate = false;
    push(s, c, msg);
  };
  /** Writes all of `b`, however many parts the socket takes it in. */
  const push = (s: Socket<Client>, c: Client, b?: Buffer) => {
    if (b) c.out.push(b);
    while (c.out.length) {
      const head = c.out[0]!;
      const n = s.write(head);
      if (n < head.length) {
        c.out[0] = head.subarray(Math.max(0, n));
        return;
      }
      c.out.shift();
    }
  };
  const serverInit = () => {
    const name = Buffer.from("Test screen");
    const b = Buffer.alloc(24 + name.length);
    b.writeUInt16BE(width, 0);
    b.writeUInt16BE(height, 2);
    // 32 bits, depth 24, little-endian, true colour, blue in the low byte (as macOS has it): the client asks for its own.
    Buffer.from([32, 24, 0, 1, 0, 255, 0, 255, 0, 255, 16, 8, 0, 0, 0, 0]).copy(b, 4);
    b.writeUInt32BE(name.length, 20);
    name.copy(b, 24);
    return b;
  };
  const step = (s: Socket<Client>, c: Client) => {
    for (;;) {
      if (c.stage === "version") {
        if (c.buf.length < 12) return;
        c.buf = c.buf.subarray(12);
        // `offers`: the sign-ins it says it takes, as given (a Linux server set to TLS only says 19, VeNCrypt).
        const types = opts.offers ?? [...(opts.account ? [30] : []), ...(opts.password ? [2] : []), ...(!opts.account && !opts.password ? [1] : [])];
        s.write(Buffer.from([types.length, ...types]));
        c.stage = "security";
      } else if (c.stage === "security") {
        if (c.buf.length < 1) return;
        const type = c.buf[0]!;
        c.buf = c.buf.subarray(1);
        if (type === 2) {
          c.challenge = Buffer.from(Array.from({ length: 16 }, (_, i) => (i * 37 + 11) & 0xff));
          s.write(c.challenge);
          c.stage = "auth";
        } else if (type === 30) {
          // Diffie-Hellman: the generator, the key's length, the prime and the server's public key.
          c.dh = createDiffieHellman(DH_PRIME, Buffer.from([2]));
          c.dh.generateKeys();
          const prime = c.dh.getPrime();
          const head = Buffer.alloc(4);
          head.writeUInt16BE(2, 0);
          head.writeUInt16BE(prime.length, 2);
          const pub = c.dh.getPublicKey();
          s.write(Buffer.concat([head, prime, Buffer.concat([Buffer.alloc(prime.length - pub.length), pub])]));
          c.stage = "ard";
        } else {
          out.signIns.push("none");
          s.write(Buffer.alloc(4));
          c.stage = "init";
        }
      } else if (c.stage === "ard") {
        const len = c.dh!.getPrime().length;
        if (c.buf.length < 128 + len) return;
        const sealed = c.buf.subarray(0, 128);
        const theirs = c.buf.subarray(128, 128 + len);
        c.buf = c.buf.subarray(128 + len);
        const secret = c.dh!.computeSecret(theirs);
        const key = createHash("md5").update(Buffer.concat([Buffer.alloc(len - secret.length), secret])).digest();
        const aes = createDecipheriv("aes-128-ecb", key, null);
        aes.setAutoPadding(false);
        const plain = Buffer.concat([aes.update(sealed), aes.final()]);
        const field = (at: number) => plain.subarray(at, plain.indexOf(0, at) < 0 || plain.indexOf(0, at) > at + 63 ? at + 64 : plain.indexOf(0, at)).toString("utf8");
        if (field(0) !== opts.account!.name || field(64) !== opts.account!.password) {
          out.refused++;
          const why = Buffer.from("Authentication or authorization failure");
          const b = Buffer.alloc(8 + why.length);
          b.writeUInt32BE(1, 0);
          b.writeUInt32BE(why.length, 4);
          why.copy(b, 8);
          s.write(b);
          s.end();
          return;
        }
        out.signIns.push(field(0));
        s.write(Buffer.alloc(4));
        c.stage = "init";
      } else if (c.stage === "auth") {
        if (c.buf.length < 16) return;
        const answer = c.buf.subarray(0, 16);
        c.buf = c.buf.subarray(16);
        const des = createCipheriv("des-ecb", desKey(opts.password!), null);
        des.setAutoPadding(false);
        const want = Buffer.concat([des.update(c.challenge), des.final()]);
        if (!want.equals(answer)) {
          out.refused++;
          const why = Buffer.from("Authentication failed");
          const b = Buffer.alloc(8 + why.length);
          b.writeUInt32BE(1, 0);
          b.writeUInt32BE(why.length, 4);
          why.copy(b, 8);
          s.write(b);
          s.end();
          return;
        }
        out.signIns.push("vnc");
        s.write(Buffer.alloc(4));
        c.stage = "init";
      } else if (c.stage === "init") {
        if (c.buf.length < 1) return;
        c.buf = c.buf.subarray(1);
        s.write(serverInit());
        c.stage = "run";
      } else {
        if (c.buf.length < 1) return;
        const type = c.buf[0]!;
        const need = type === 0 ? 20 : type === 2 ? 4 + 4 * (c.buf.length >= 4 ? c.buf.readUInt16BE(2) : 0) : type === 3 ? 10 : type === 4 ? 8 : type === 5 ? 6 : type === 6 ? 8 + (c.buf.length >= 8 ? c.buf.readUInt32BE(4) : 0) : 1;
        if (c.buf.length < Math.max(need, type === 2 ? 4 : type === 6 ? 8 : need)) return;
        const m = c.buf.subarray(0, need);
        c.buf = c.buf.subarray(need);
        if (type === 0) c.shifts = [m[14]!, m[15]!, m[16]!];
        else if (type === 3) {
          c.wantsUpdate = true;
          // A full request is answered at once; an incremental one waits for the next paint.
          if (m[1] === 0 || c.dirty) {
            c.dirty = false;
            sendRect(s, c, 0, 0, width, height);
          }
        } else if (type === 4) out.events.push({ t: "key", sym: m.readUInt32BE(4), down: m[1] === 1 });
        else if (type === 5) out.events.push({ t: "pointer", buttons: m[1]!, x: m.readUInt16BE(2), y: m.readUInt16BE(4) });
      }
    }
  };
  const server: TCPSocketListener<Client> = Bun.listen<Client>({
    hostname: "127.0.0.1",
    port: 0,
    socket: {
      open(s) {
        s.data = { buf: Buffer.alloc(0), stage: "version", challenge: Buffer.alloc(0), wantsUpdate: false, dirty: false, out: [], shifts: [16, 8, 0] };
        clients.set(s, s.data);
        s.write("RFB 003.889\n");
      },
      data(s, chunk) {
        s.data.buf = Buffer.concat([s.data.buf, chunk]);
        step(s, s.data);
      },
      drain(s) {
        push(s, s.data);
      },
      close(s) {
        clients.delete(s);
      },
      error() {},
    },
  });
  out.port = server.port;
  return out;
}
