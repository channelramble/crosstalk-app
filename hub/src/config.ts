import { mkdirSync, existsSync, readFileSync, writeFileSync, chmodSync, closeSync, openSync } from "node:fs";
import { homedir, hostname } from "node:os";
import { join, resolve } from "node:path";

export const HUB_VERSION = "0.11.0";
/** A random name for this run of the hub, new at every start. It tells nothing about the machine; the hub knows its own answer by it. */
export const HUB_RUN = crypto.randomUUID();

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

/**
 * The data folder and what's in it are this user's alone, checked at every start (not only when they're made): the
 * folder and `run` 0700, the database and the config 0600. The database is made here, empty, before SQLite opens it,
 * because SQLite gives its -wal and -shm files the database's own mode. Windows has no such modes.
 */
export function ensureDirs() {
  for (const d of [HOME, RUN_DIR]) if (!existsSync(d)) mkdirSync(d, { recursive: true, mode: 0o700 });
  if (process.platform === "win32") return;
  const own = (path: string, mode: number) => {
    try {
      chmodSync(path, mode);
    } catch {
      /* not ours to change (a folder someone mounted): the hub still runs */
    }
  };
  for (const d of [HOME, RUN_DIR]) own(d, 0o700);
  try {
    if (!existsSync(DB_PATH)) closeSync(openSync(DB_PATH, "a", 0o600));
  } catch {
    /* SQLite makes it then */
  }
  for (const f of [DB_PATH, `${DB_PATH}-wal`, `${DB_PATH}-shm`, CONFIG_PATH, SECRETS_PATH]) if (existsSync(f)) own(f, 0o600);
}

export function loadConfig(): HubConfig {
  ensureDirs();
  let file: Partial<HubConfig> = {};
  if (existsSync(CONFIG_PATH)) {
    try {
      file = JSON.parse(readFileSync(CONFIG_PATH, "utf8"));
    } catch {}
  } else {
    writeFileSync(CONFIG_PATH, JSON.stringify({ ...DEFAULTS }, null, 2), { mode: 0o600 });
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
  writeFileSync(CONFIG_PATH, JSON.stringify({ ...cur, ...patch }, null, 2), { mode: 0o600 });
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
