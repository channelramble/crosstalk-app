// Prints what a hub says of OpenCode (where it found it, the version, what's wrong). Run in a process of its own with HOME set
// to a temp folder, because a process reads its home once: hub/test/opencode-install.test.ts.
import { App } from "../../src/app";
import "../../src/providers/all";

const app = new App({ dbPath: ":memory:", config: { port: 0, host: "127.0.0.1", publicUrl: null, workspaceRoot: process.env.HOME!, maxHopsDefault: 6 } });
console.log(JSON.stringify(await app.providers.refresh("opencode")));
await app.shutdown();
process.exit(0);
