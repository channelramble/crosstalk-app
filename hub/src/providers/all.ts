// Registers every provider module and agent driver. Imported once by main.ts.
import { PROVIDER_INFO, type PermissionMode, type Provider } from "@crosstalk/shared";
import { registerProvider } from "./index";
import { registerDriver } from "../agents";
import type { DriverContext } from "../agents/driver";
import { ClaudeDriver } from "../agents/claude";
import { CodexDriver } from "../agents/codex";
import { MuseDriver } from "../agents/muse";
import { AcpDriver } from "../agents/acp";
import { claudeProvider } from "./claude";
import { codexProvider } from "./codex";
import { museProvider } from "./muse";
import { geminiAcpFlag, geminiProvider } from "./gemini";
import { antigravityProvider } from "./antigravity";
import { AntigravityDriver } from "../agents/antigravity";
import { BuiltinDriver } from "../agents/builtin";
import { builtinProvider } from "./builtin";
import { OpenCodeDriver } from "../agents/opencode";
import { opencodeProvider } from "./opencode";

function needBin(ctx: DriverContext): string {
  if (!ctx.bin) throw new Error(`${PROVIDER_INFO[ctx.member.provider as Provider].name} isn't installed on the hub. Install it under Settings → AI services.`);
  return ctx.bin;
}

registerProvider(claudeProvider);
registerDriver("claude", (ctx) => new ClaudeDriver(ctx, needBin(ctx)));

// Crosstalk's own agent: no program, so no binary to need. It runs on an AI service account (endpoint) only.
registerProvider(builtinProvider);
registerDriver("builtin", (ctx) => new BuiltinDriver(ctx));

// OpenCode: a program of its own, driven over ACP, that also runs only on an AI service account (endpoint).
registerProvider(opencodeProvider);
registerDriver("opencode", (ctx) => new OpenCodeDriver(ctx, needBin(ctx)));

registerProvider(codexProvider);
registerDriver("codex", (ctx) => new CodexDriver(ctx, needBin(ctx)));

registerProvider(museProvider);
registerDriver("muse", (ctx) => new MuseDriver(ctx, needBin(ctx)));

registerProvider(antigravityProvider);
registerDriver("antigravity", (ctx) => new AntigravityDriver(ctx, needBin(ctx)));

registerProvider(geminiProvider);
registerDriver("gemini", (ctx) => {
  const bin = needBin(ctx);
  const approval: Record<PermissionMode, string[]> = { ask: [], edits: ["--approval-mode", "auto_edit"], auto: ["--approval-mode", "auto_edit"], full: ["--yolo"] };
  // The ACP flag is detected lazily; start with the current name and let the driver report failures.
  const model = ctx.member.model ? ["--model", ctx.member.model] : [];
  return new LazyGemini(ctx, bin, [...approval[ctx.member.permissionMode], ...model]);
});

/** Resolves Gemini's ACP flag on first use, then behaves as a normal ACP driver. */
class LazyGemini extends AcpDriver {
  private ready: Promise<void> | null = null;
  constructor(ctx: DriverContext, private gbin: string, private extra: string[]) {
    super("gemini", ctx, [gbin, "--experimental-acp", ...extra], { name: "Gemini CLI" });
    this.ready = geminiAcpFlag(gbin, ctx.env).then((flag) => {
      this.argv = [this.gbin, flag, ...this.extra];
    });
  }
  override async runTurn(...args: Parameters<AcpDriver["runTurn"]>) {
    await this.ready;
    return super.runTurn(...args);
  }
}

registerProvider({
  id: "mock",
  binNames: ["true"],
  extraPaths: [],
  versionArgs: [],
  installCommand: null,
  async checkAuth() {
    return { signedIn: true, account: "built-in", plan: "Test agent", authMethod: "none", version: "built-in" };
  },
});
