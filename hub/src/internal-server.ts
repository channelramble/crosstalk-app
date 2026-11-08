// The hub's internal API, for the MCP helpers agents launch (approvals, questions, room tools, other chats) and the
// setup tools (setup/). It listens on a Unix socket in the hub's run folder, and each call carries the calling member's
// own key, or the setup key. Nothing of it is published: the helpers' half is on this socket alone, and the setup half
// also answers on the hub's port (server.ts) for a request made on this machine straight to the hub, which is what a
// sandbox that blocks Unix sockets but allows localhost leaves an agent (setup/cli.ts).

import { chmodSync, unlinkSync } from "node:fs";
import type { App } from "./app";
import { handleInternal } from "./mcp/internal";
import { handleSetupInternal } from "./setup";
import { logger } from "./util/log";

const log = logger("internal");

export function startInternalServer(app: App): { stop(): void } {
  try {
    unlinkSync(app.internalSocket); // left over from a previous run
  } catch {
    /* none */
  }
  // Approvals and replies from other chats wait for a person: never time them out here (Bun's types leave
  // idleTimeout out for Unix sockets, but it applies to them).
  const server = Bun.serve({
    unix: app.internalSocket,
    idleTimeout: 0,
    fetch: (req: Request) => {
      const url = new URL(req.url);
      // The setup tools (`crosstalk-hub setup`, setup-mcp) carry the setup key instead of a member's.
      return url.pathname.startsWith("/internal/setup/") ? handleSetupInternal(app, req, url) : handleInternal(app, req, url);
    },
  } as unknown as Parameters<typeof Bun.serve>[0]);
  try {
    chmodSync(app.internalSocket, 0o600);
  } catch (e) {
    log.warn(`couldn't restrict ${app.internalSocket}: ${e}`);
  }
  return {
    stop() {
      void server.stop(true);
      try {
        unlinkSync(app.internalSocket);
      } catch {
        /* gone */
      }
    },
  };
}
