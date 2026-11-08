/**
 * The "?" tips (views/HelpTip.tsx) next to Settings headings, the New chat dialog's permissions and Helper agents: one
 * plain sentence each, all in this table so they can be read and checked together (helpCopy.test.ts: short, one
 * sentence, none of JARGON_WORDS). `label` is what the "?" button says to a screen reader.
 */
export type HelpTopic = "modelPool" | "machines" | "computers" | "thisMac" | "teamwork" | "storage" | "usage" | "permissions" | "helpers" | "templates";

export const HELP: Record<HelpTopic, { label: string; text: string }> = {
  modelPool: { label: "What's the model pool?", text: "Lets your computers share their memory to run one big AI model that none of them could run alone." },
  machines: { label: "What are machines?", text: "Other computers running Crosstalk that you link here, so you can chat with the agents on any of them." },
  computers: { label: "What are these computers?", text: "Other computers your agents can run commands on, like a laptop with a phone plugged in." },
  thisMac: { label: "What does This Mac check?", text: "Checks that this Mac keeps Crosstalk running by itself, even after a restart or a power cut." },
  teamwork: { label: "What's teamwork?", text: "Lets Claude Code and Codex ask each other a quick question when a second opinion would help." },
  storage: { label: "What's storage?", text: "How much disk space is left on this computer, what's using it, and how to free some." },
  usage: { label: "What's usage?", text: "How much of each plan's allowance you've used, and what your accounts cost." },
  permissions: { label: "What do the permissions mean?", text: "How much your agent may do without asking you first; the first choice is the safest." },
  helpers: { label: "What are helper agents?", text: "Extra agents that yours starts to work on parts of a big job, using the model you pick here." },
  templates: { label: "What are templates?", text: "Saved first messages to start a chat from, with blanks you fill in each time." },
};

/** Technical words the tips and the welcome card never use (checked in their tests). */
export const JARGON_WORDS = ["api", "gpu", "vram", "rpc", "ssh", "vpn", "daemon", "tailnet", "tailscale", "token", "endpoint", "proxy", "inference", "sandbox", "cli", "latency", "hub", "cache", "hop", "subagent", "llama", "docker", "localhost"];

/** The first of JARGON_WORDS a sentence uses, as a whole word, or null. */
export function jargonIn(text: string): string | null {
  return JARGON_WORDS.find((w) => new RegExp(`\\b${w}s?\\b`, "i").test(text)) ?? null;
}
