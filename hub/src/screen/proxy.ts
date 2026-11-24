// The phone's live view of the screen: the app's viewer speaks RFB to the hub as if to a server with no password (the
// device is already paired, and people's devices only get here), the hub signs in to the real one, and after that
// bytes pass straight through both ways. The password never leaves the hub.

import { ByteReader, type RfbConnection } from "./rfb";

/** More than this waiting to go to a slow device and the view is closed (it connects again, to the screen as it is). */
const MAX_BUFFERED = 48 * 1024 * 1024;

export interface ViewerSocket {
  send(bytes: Uint8Array): void;
  close(why?: string): void;
  buffered(): number;
}

export class ScreenViewer {
  private reader = new ByteReader();
  private server: RfbConnection | null = null;
  private piping = false;
  private closed = false;

  constructor(
    private ws: ViewerSocket,
    private attach: () => Promise<RfbConnection>,
    private detach: (c: RfbConnection) => void,
  ) {
    void this.run();
  }

  private async run() {
    const enc = new TextEncoder();
    try {
      this.ws.send(enc.encode("RFB 003.008\n"));
      await this.reader.read(12); // the viewer's version
      let server: RfbConnection;
      try {
        server = await this.attach();
      } catch (e) {
        // RFB's way of refusing: no security types, and why. The viewer shows the words.
        const why = enc.encode(e instanceof Error ? e.message : String(e));
        const out = new Uint8Array(5 + why.length);
        new DataView(out.buffer).setUint32(1, why.length);
        out.set(why, 5);
        this.ws.send(out);
        return this.close();
      }
      if (this.closed) return this.detach(server);
      this.server = server;
      this.ws.send(new Uint8Array([1, 1])); // one way in: none
      await this.reader.read(1); // the viewer picks it
      this.ws.send(new Uint8Array(4)); // and it went fine
      await this.reader.read(1); // ClientInit (the hub already said "shared" to the real server)
      this.ws.send(server.init.raw);
      this.piping = true;
      const early = this.reader.rest();
      if (early.length) server.socket.write(early);
      server.takeOver(
        (bytes) => {
          if (this.closed) return;
          if (this.ws.buffered() > MAX_BUFFERED) return this.close("The connection to this device is too slow for the live view.");
          this.ws.send(bytes);
        },
        () => this.close(),
      );
    } catch {
      this.close();
    }
  }

  /** Bytes from the device's viewer. */
  message(bytes: Uint8Array) {
    if (this.closed) return;
    if (this.piping) this.server?.socket.write(bytes);
    else this.reader.push(bytes);
  }

  close(why?: string) {
    if (this.closed) return;
    this.closed = true;
    this.reader.end(new Error("closed"));
    if (this.server) this.detach(this.server);
    this.ws.close(why);
  }
}
