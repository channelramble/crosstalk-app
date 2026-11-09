import { mkdirSync, existsSync, readFileSync, writeFileSync, chmodSync } from "node:fs";
import { homedir, hostname } from "node:os";
import { join, resolve } from "node:path";

export const HUB_VERSION = "0.6.9";

export interface HubConfig {
  port: number;
  host: string;
  publicUrl: string | null; // e.g. https://box.tailnet.ts.net, set by install.sh
  workspaceRoot: string; // where new room folders are created
  maxHopsDefault: number;
}

export const HOME = resolve(process.env.CROSSTALK_HOME || join(homedir(), ".crosstalk"));
export const DB_PATH = join(HOME, "crosstalk.db");
export const CONFIG_PATH = join(HOME, "config.json");
export const SECRETS_PATH = join(HOME, "secrets.json");
export const RUN_DIR = join(HOME, "run"); // generated MCP configs, per-member files
export const HOSTNAME = hostname();

const DEFAULTS: HubConfig = {
  port: Number(process.env.CROSSTALK_PORT || 7420),
  host: process.env.CROSSTALK_HOST || "127.0.0.1",
  publicUrl: process.env.CROSSTALK_PUBLIC_URL || null,
  workspaceRoot: process.env.CROSSTALK_WORKSPACES || join(homedir(), "crosstalk-workspaces"),
  maxHopsDefault: 6,
};

export function ensureDirs() {
  for (const d of [HOME, RUN_DIR]) if (!existsSync(d)) mkdirSync(d, { recursive: true, mode: 0o700 });
}

export function loadConfig(): HubConfig {
  ensureDirs();
  let file: Partial<HubConfig> = {};
  if (existsSync(CONFIG_PATH)) {
    try {
      file = JSON.parse(readFileSync(CONFIG_PATH, "utf8"));
    } catch {}
  } else {
    writeFileSync(CONFIG_PATH, JSON.stringify({ ...DEFAULTS }, null, 2));
  }
  // Environment variables win over the file so dev runs and systemd units can override.
  const cfg: HubConfig = { ...DEFAULTS, ...file };
  if (process.env.CROSSTALK_PORT) cfg.port = Number(process.env.CROSSTALK_PORT);
  if (process.env.CROSSTALK_HOST) cfg.host = process.env.CROSSTALK_HOST;
  if (process.env.CROSSTALK_PUBLIC_URL) cfg.publicUrl = process.env.CROSSTALK_PUBLIC_URL;
  if (process.env.CROSSTALK_WORKSPACES) cfg.workspaceRoot = process.env.CROSSTALK_WORKSPACES;
  cfg.workspaceRoot = resolve(cfg.workspaceRoot.replace(/^~(?=\/)/, homedir()));
  if (!existsSync(cfg.workspaceRoot)) mkdirSync(cfg.workspaceRoot, { recursive: true });
  return cfg;
}

export function saveConfig(patch: Partial<HubConfig>) {
  const cur = existsSync(CONFIG_PATH) ? JSON.parse(readFileSync(CONFIG_PATH, "utf8")) : {};
  writeFileSync(CONFIG_PATH, JSON.stringify({ ...cur, ...patch }, null, 2));
}

/** Small secrets store for things the user pastes in (e.g. a Muse API key). Mode 600. */
export function readSecrets(): Record<string, string> {
  if (!existsSync(SECRETS_PATH)) return {};
  try {
    return JSON.parse(readFileSync(SECRETS_PATH, "utf8"));
  } catch {
    return {};
  }
}

export function writeSecret(key: string, value: string | null) {
  const s = readSecrets();
  if (value === null) delete s[key];
  else s[key] = value;
  writeFileSync(SECRETS_PATH, JSON.stringify(s, null, 2), { mode: 0o600 });
  chmodSync(SECRETS_PATH, 0o600);
}
