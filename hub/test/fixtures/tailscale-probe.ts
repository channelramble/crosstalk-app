// Asks Tailscale the shared way in a process of its own, with every log line on, and prints what came back. The test
// (hub/test/tailscale.test.ts) runs this to check that the macOS app's proof token is in neither the answer nor a log
// line. The folder to read comes from CROSSTALK_TAILSCALE_APP_DIR, so nothing here touches /Library.
import { askTailscale } from "../../src/tailscale";
import { parseTailscaleStatus } from "../../src/setup/system";

const a = await askTailscale({ serve: true });
console.log(JSON.stringify({ cli: a.cli, tried: a.tried, from: a.from, ...parseTailscaleStatus(a.status), status: a.status, serve: a.serve }));
