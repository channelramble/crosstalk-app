// Run in its own process with CROSSTALK_HOME pointing at a temp folder: API keys go to the hub's secrets file.
import { App } from "../../src/app";

const dir = process.env.CROSSTALK_HOME!;
const app = new App({ dbPath: ":memory:", config: { port: 0, host: "127.0.0.1", publicUrl: null, workspaceRoot: dir, maxHopsDefault: 6 } });
const out: Record<string, unknown> = {};
const fail = async (f: () => Promise<unknown>) => f().then(() => "ok", (e) => String(e.message ?? e));
const acct = await app.providers.setApiKeyAccount("claude", "sk-ant-api03-test-key-0123456789", { label: "Org key", workspaceId: "wrkspc_01ABC" });
out.header = app.providers.agentEnv("claude", acct.id).ANTHROPIC_CUSTOM_HEADERS ?? null;
out.key = app.providers.agentEnv("claude", acct.id).ANTHROPIC_API_KEY === "sk-ant-api03-test-key-0123456789";
out.listed = app.providers.accounts().find((a) => a.id === acct.id)?.workspaceId ?? null;
out.badId = await fail(() => app.providers.setApiKeyAccount("claude", "", { id: acct.id, workspaceId: "not a workspace" }));
// Clearing the workspace keeps the key.
await app.providers.setApiKeyAccount("claude", "", { id: acct.id, workspaceId: null });
out.cleared = app.providers.agentEnv("claude", acct.id).ANTHROPIC_CUSTOM_HEADERS ?? null;
out.keptKey = app.providers.agentEnv("claude", acct.id).ANTHROPIC_API_KEY === "sk-ant-api03-test-key-0123456789";
// Renaming keeps it an API key account.
app.providers.renameAccount("claude", acct.id, "Renamed");
out.renamedKind = app.providers.accounts().find((a) => a.id === acct.id)?.kind ?? null;
await app.engine.shutdown();
app.store.close();
console.log(JSON.stringify(out));
