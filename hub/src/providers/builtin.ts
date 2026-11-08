// Crosstalk's own agent (agents/builtin.ts) as a provider: nothing to install, nothing to sign in to. Its accounts are AI
// services (endpoint accounts) it runs on, added in Settings → AI services; it has no account of its own.
import type { ProviderModule } from "./index";

export const builtinProvider: ProviderModule = {
  id: "builtin",
  binNames: [],
  extraPaths: [],
  versionArgs: [],
  installCommand: null,
};
