import { connect, type Socket } from "node:net";
import { randomBytes } from "node:crypto";

/**
 * A minimal WebSocket client over a Unix domain socket (text messages only). The Codex app's app-server daemon
 * listens this way, and Bun's WebSocket can't connect to a Unix socket.
 */
export class UdsWebSocket {
  private sock: Socket;
  private buf = Buffer.alloc(0);
  private open = false;
  private fragments: Buffer[] = [];
  private closed = false;
  onmessage: (text: string) => void = () => {};
  onclose: () => void = () => {};
  readonly ready: Promise<void>;

  constructor(path: string) {
    this.sock = connect(path);
    this.ready = new Promise((resolve, reject) => {
      this.sock.once("error", (e) => {
        if (!this.open) reject(e);
      });
      this.sock.on("connect", () => {
        const key = randomBytes(16).toString("base64");
        this.sock.write(`GET / HTTP/1.1\r\nHost: localhost\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: ${key}\r\nSec-WebSocket-Version: 13\r\n\r\n`);
      });
      this.sock.on("data", (d) => {
        this.buf = Buffer.concat([this.buf, typeof d === "string" ? Buffer.from(d) : d]);
        if (!this.open) {
          const end = this.buf.indexOf("\r\n\r\n");
          if (end < 0) return;
          const head = this.buf.subarray(0, end).toString("latin1");
          if (!/^HTTP\/1\.1 101/.test(head)) {
            reject(new Error(`the server refused the connection (${head.split("\r\n")[0]})`));
            this.sock.destroy();
            return;
          }
          this.open = true;
          this.buf = this.buf.subarray(end + 4);
          resolve();
        }
        this.drain();
      });
      this.sock.on("close", () => {
        if (!this.open) reject(new Error("the connection closed during the handshake"));
        if (!this.closed) {
          this.closed = true;
          this.onclose();
        }
      });
      this.sock.on("error", () => {
        // close follows
      });
    });
  }

  /** Reads every complete frame in the buffer. */
  private drain() {
    for (;;) {
      if (this.buf.length < 2) return;
      const b0 = this.buf[0];
      const b1 = this.buf[1];
      let len = b1 & 0x7f;
      let off = 2;
      if (len === 126) {
        if (this.buf.length < 4) return;
        len = this.buf.readUInt16BE(2);
        off = 4;
      } else if (len === 127) {
        if (this.buf.length < 10) return;
        len = Number(this.buf.readBigUInt64BE(2));
        off = 10;
      }
      const masked = (b1 & 0x80) !== 0;
      const maskAt = off;
      if (masked) off += 4;
      if (this.buf.length < off + len) return;
      let payload = this.buf.subarray(off, off + len);
      if (masked) {
        const mask = this.buf.subarray(maskAt, maskAt + 4);
        payload = Buffer.from(payload.map((x, i) => x ^ mask[i & 3]));
      }
      this.buf = this.buf.subarray(off + len);
      const fin = (b0 & 0x80) !== 0;
      const op = b0 & 0x0f;
      if (op === 0x9) this.frame(0xa, payload); // ping -> pong
      else if (op === 0x8) this.sock.end(); // close
      else if (op === 0x1 || op === 0x0) {
        this.fragments.push(payload);
        if (fin) {
          const text = Buffer.concat(this.fragments).toString("utf8");
          this.fragments = [];
          this.onmessage(text);
        }
      }
    }
  }

  /** Writes one masked frame (clients must mask). */
  private frame(op: number, payload: Buffer) {
    const mask = randomBytes(4);
    const len = payload.length;
    let head: Buffer;
    if (len < 126) head = Buffer.from([0x80 | op, 0x80 | len]);
    else if (len < 65536) {
      head = Buffer.alloc(4);
      head[0] = 0x80 | op;
      head[1] = 0x80 | 126;
      head.writeUInt16BE(len, 2);
    } else {
      head = Buffer.alloc(10);
      head[0] = 0x80 | op;
      head[1] = 0x80 | 127;
      head.writeBigUInt64BE(BigInt(len), 2);
    }
    const body = Buffer.from(payload.map((x, i) => x ^ mask[i & 3]));
    this.sock.write(Buffer.concat([head, mask, body]));
  }

  send(text: string) {
    if (!this.open || this.closed) return;
    this.frame(0x1, Buffer.from(text, "utf8"));
  }

  close() {
    if (this.closed) return;
    try {
      if (this.open) this.frame(0x8, Buffer.alloc(0));
    } catch {
      // the socket is already gone
    }
    this.sock.end();
  }
}
