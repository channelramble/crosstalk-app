// Updates from the app. Until now a new version reached a machine only when someone ran the installer on it again. Now
// Crosstalk asks GitHub for the newest release of the repo it was installed from (a little after it starts, about every
// six hours, and when asked), says so on every device when there's a newer one, and one button downloads it:
//
//   1. the release's SHA256SUMS and the program for this machine's system and processor, to a file beside the running
//      program (never over it);
//   2. the download must match its checksum, and must say it is that version when run (on a Mac it's cleared of
//      quarantine and signed first, the way deploy/install-macos.sh does it);
//   3. it's then renamed to where a new build waits (setup/system.ts nextBuildPath). From there on it's the update that
//      applies itself (update.ts): every device hears "Update X is ready", and it starts once the chats are quiet.
//
// Anything that goes wrong leaves the machine as it was: the half-made file is removed and the app says why. Nothing
// about the person or the machine is sent: the requests are the ones any download makes, with a plain User-Agent.
// A Crosstalk run from its source code, started by hand, or in a folder it can't write to offers nothing and asks
// nothing.

import { accessSync, chmodSync, closeSync, constants, openSync, readdirSync, renameSync, rmSync, writeSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { compareVersions, type HubRelease, type HubUpdate, type UpdateInstall, type UpdateStatus } from "@crosstalk/shared";
import { nextBuildPath } from "./setup/system";
import { logger } from "./util/log";

const log = logger("update");

/** The repo releases come from: the one install.sh installs from (CROSSTALK_REPO names another, as it does there). */
export const DEFAULT_REPO = "channelramble/crosstalk-app";
const FIRST_CHECK_MS = 45_000;
const CHECK_EVERY_MS = 6 * 60 * 60_000;
/** Check now, tapped again within this, gets the answer just given. */
const ASK_AGAIN_MS = 5_000;
const NOTES_MAX = 6_000;
/** A download with nothing arriving for this long is given up. */
const STALL_MS = 60_000;
/** No release's program is anywhere near this: a download that goes past it isn't one. */
const MAX_BYTES = 1024 * 1024 * 1024;
const AGENT = { "User-Agent": "crosstalk-hub" };

type Run = (args: string[], timeoutMs?: number) => Promise<{ code: number; out: string } | null>;

export interface SelfUpdateDeps {
  /** The version that runs. */
  version: string;
  /** The running program's file, and whether it is Crosstalk's own program (not bun running the source). */
  path: string;
  compiled: boolean;
  platform: string;
  arch: string;
  /** Answers like GitHub's "latest release": { tag_name, body, assets: [{ name, size }] }. */
  latestUrl: string;
  /** Where a release's file is. */
  fileUrl(tag: string, name: string): string;
  /** Runs a program quietly: the download itself (`version`), and on a Mac xattr, security and codesign. */
  run: Run;
  /** Whether something starts Crosstalk again when it exits (launchd, systemd). Null: not known. */
  restarts?(): Promise<boolean | null>;
  /** The update that's downloaded and waiting, if any (update.ts). */
  ready(): HubUpdate | null;
  /** A new build is in place beside the running one: the Updater looks now. */
  staged(): Promise<void>;
  /** Tells every device (the hub's info carries the offer and the download's progress). */
  changed(): void;
  now?(): number;
  /** Off: no looking by itself (CROSSTALK_NO_UPDATE_CHECK); Check now and Update still work. */
  auto?: boolean;
  stallMs?: number;
}

/** Where releases are, from the environment: the names install.sh uses, plus one for the "latest release" answer. */
export function releaseSource(env: Record<string, string | undefined> = process.env): Pick<SelfUpdateDeps, "latestUrl" | "fileUrl"> {
  const repo = /^[\w.-]+\/[\w.-]+$/.test(env.CROSSTALK_REPO ?? "") ? env.CROSSTALK_REPO! : DEFAULT_REPO;
  const base = env.CROSSTALK_DOWNLOAD_BASE?.replace(/\/+$/, "");
  return {
    latestUrl: env.CROSSTALK_UPDATE_URL || `https://api.github.com/repos/${repo}/releases/latest`,
    fileUrl: (tag, name) => (base ? `${base}/${name}` : `https://github.com/${repo}/releases/download/${tag}/${name}`),
  };
}

/** The release's program for a system and processor, as .github/workflows/release.yml names them. Null: there's none. */
export function programName(platform: string, arch: string): string | null {
  const os = platform === "darwin" || platform === "linux" ? platform : null;
  const cpu = arch === "arm64" || arch === "x64" ? arch : null;
  return os && cpu ? `crosstalk-hub-${os}-${cpu}` : null;
}

/** A failure whose words are for the person as they are. */
class Plain extends Error {}

/** The update can't be offered here: the route answers with why. */
export class CantUpdate extends Error {}

/** Only https, or this machine itself (a test's release server): a release is never fetched in the clear. */
function checked(url: string): string {
  const u = new URL(url);
  if (u.protocol === "https:" || (u.protocol === "http:" && ["127.0.0.1", "localhost", "[::1]"].includes(u.hostname))) return url;
  throw new Plain("The address updates come from isn't an https one, so nothing was downloaded.");
}

interface Latest {
  version: string;
  tag: string;
  notes: string | null;
  /** The program's size as the release lists it (null: not listed). */
  size: number | null;
}

export class SelfUpdate {
  private latest: Latest | null = null;
  private checkedAt: number | null = null;
  private checkFailed = false;
  private lastAsked = 0;
  private checking: Promise<void> | null = null;
  private job: UpdateInstall | null = null;
  private running: Promise<void> | null = null;
  private abort: AbortController | null = null;
  private restarts: Promise<boolean | null> | null = null;
  private timers: ReturnType<typeof setTimeout>[] = [];
  private stopped = false;
  private lastSaid = JSON.stringify({ available: null, install: null } satisfies HubRelease);

  constructor(private deps: SelfUpdateDeps) {}

  private now() {
    return this.deps.now?.() ?? Date.now();
  }
  private get program() {
    return programName(this.deps.platform, this.deps.arch);
  }
  /** The file a download is made in, beside where it will wait. */
  private get part() {
    return `${nextBuildPath(this.deps.path)}.part`;
  }

  /** Whether this Crosstalk can update itself, and if not, why, in words for the person. */
  async able(): Promise<{ can: boolean; why: string | null }> {
    const no = (why: string) => ({ can: false, why });
    if (!this.deps.compiled) return no("This Crosstalk runs from its source code, so there's nothing to download: update the code instead.");
    if (!this.program) return no(`There's no download of Crosstalk for this kind of machine (${this.deps.platform}, ${this.deps.arch}).`);
    try {
      accessSync(dirname(this.deps.path), constants.W_OK);
    } catch {
      return no(`Crosstalk can't write to the folder its program is in (${dirname(this.deps.path)}), so it can't update itself. Run the installer again to update.`);
    }
    this.restarts ??= this.deps.restarts?.().catch(() => null) ?? Promise.resolve(null);
    if ((await this.restarts) === false) return no("Crosstalk was started by hand on this machine, so nothing would start it again after an update. Run the installer to update it.");
    return { can: true, why: null };
  }

  /** Looks a little after the hub starts, then about every six hours. Nothing, for a Crosstalk that can't update itself. */
  start() {
    if (!this.deps.compiled) return;
    // A download the hub was stopped in the middle of.
    rmSync(this.part, { force: true });
    if (this.deps.auto === false) return;
    const look = () => void this.check().catch(() => {});
    const first = setTimeout(look, FIRST_CHECK_MS);
    const every = setInterval(look, CHECK_EVERY_MS);
    for (const t of [first, every]) (t as { unref?: () => void }).unref?.();
    this.timers = [first, every];
  }

  stop() {
    this.stopped = true;
    for (const t of this.timers) clearTimeout(t);
    this.timers = [];
    this.abort?.abort();
  }

  /** The newer version there is to download: not one that's downloaded and waiting already. */
  private available(): string | null {
    if (!this.latest) return null;
    const ready = this.deps.ready()?.version;
    if (ready && (compareVersions(ready, this.latest.version) ?? -1) >= 0) return null;
    return this.latest.version;
  }

  /** What every device is told (HubInfo.release). */
  brief(): HubRelease {
    return { available: this.available(), install: this.job };
  }

  async status(): Promise<UpdateStatus> {
    const able = await this.able();
    const available = this.available();
    return { version: this.deps.version, ...able, available, install: this.job, notes: available ? this.latest?.notes ?? null : null, checkedAt: this.checkedAt, checkFailed: this.checkFailed, ready: this.deps.ready() };
  }

  /** Asks GitHub for the newest release. Quiet when it can't be reached: `checkFailed` says so to whoever asked. */
  async check(): Promise<void> {
    if (!(await this.able()).can) return;
    if (this.checking) return this.checking;
    if (this.lastAsked && this.now() - this.lastAsked < ASK_AGAIN_MS) return;
    return this.ask();
  }

  private ask(): Promise<void> {
    this.lastAsked = this.now();
    this.checking = (async () => {
      try {
        this.latest = await this.newest();
        this.checkedAt = this.now();
        this.checkFailed = false;
        // A download that failed is offered afresh.
        if (this.job?.step === "failed" && !this.running) this.job = null;
      } catch (e) {
        // A machine that's offline is normal: what was known stays, and nothing is said unless someone asked.
        this.checkFailed = true;
        log.debug(`couldn't ask for the newest release: ${e instanceof Error ? e.message : String(e)}`);
      }
    })().finally(() => {
      this.checking = null;
      this.say();
    });
    return this.checking;
  }

  /** The newest release when it's newer than what runs and has a program for this machine; null otherwise. */
  private async newest(): Promise<Latest | null> {
    const res = await fetch(checked(this.deps.latestUrl), { headers: { ...AGENT, Accept: "application/vnd.github+json" }, signal: AbortSignal.timeout(10_000) });
    if (!res.ok) throw new Error(`the answer was ${res.status}`);
    const j = (await res.json()) as { tag_name?: unknown; body?: unknown; draft?: unknown; prerelease?: unknown; assets?: unknown };
    const tag = typeof j.tag_name === "string" ? j.tag_name.trim() : "";
    if (!/^v?\d+\.\d+\.\d+$/.test(tag)) throw new Error("the answer names no version");
    if (j.draft === true || j.prerelease === true) return null;
    const version = tag.replace(/^v/, "");
    if ((compareVersions(version, this.deps.version) ?? 0) <= 0) return null;
    let size: number | null = null;
    if (Array.isArray(j.assets)) {
      const asset = (j.assets as { name?: unknown; size?: unknown }[]).find((a) => a?.name === this.program);
      // A release that lists its files and has none for this machine isn't one it can take.
      if (!asset) return null;
      size = typeof asset.size === "number" && asset.size > 0 ? asset.size : null;
    }
    const body = typeof j.body === "string" ? j.body.trim() : "";
    return { version, tag, size, notes: body ? (body.length > NOTES_MAX ? `${body.slice(0, NOTES_MAX).trimEnd()}…` : body) : null };
  }

  /**
   * Update, from the app: starts the download and comes back at once (its progress is in HubInfo.release). A second
   * tap while one runs starts nothing.
   */
  async install(): Promise<void> {
    const able = await this.able();
    if (!able.can) throw new CantUpdate(able.why ?? "Crosstalk can't update itself on this machine.");
    if (this.running) return;
    this.job = { version: this.available() ?? "", step: "checking", percent: null };
    this.say();
    this.running = this.download()
      // (It says what went wrong itself; nothing it throws may take the hub down.)
      .catch((e) => log.warn("the update's download ended oddly", e))
      .finally(() => {
        this.running = null;
        this.abort = null;
      });
  }

  /** The download that's running, for a test to wait on. */
  done(): Promise<void> {
    return this.running ?? Promise.resolve();
  }

  private step(job: UpdateInstall) {
    this.job = job;
    this.say();
  }

  private async download(): Promise<void> {
    const { path, run } = this.deps;
    const part = this.part;
    let version = this.job?.version ?? "";
    try {
      // What's newest now, not what was newest hours ago.
      if (this.checking) await this.checking;
      await this.ask();
      if (this.checkFailed) throw new Plain("Couldn't reach GitHub to get the update. Check this machine's internet connection, then try again.");
      const want = this.latest;
      // Nothing newer after all, or it's here already and waiting.
      if (!want || !this.available()) {
        this.job = null;
        this.say();
        return;
      }
      version = want.version;
      this.step({ version, step: "checking", percent: null });
      const name = this.program!;
      this.abort = new AbortController();
      const sums = await this.text(this.deps.fileUrl(want.tag, "SHA256SUMS"));
      const sha = sums
        .split("\n")
        .map((l) => /^([0-9a-f]{64})\s+\*?(\S+)$/i.exec(l.trim()))
        .find((m) => m?.[2] === name)?.[1]
        .toLowerCase();
      if (!sha) throw new Plain(`Crosstalk ${version} has no download for this kind of machine (${this.deps.platform}, ${this.deps.arch}).`);

      this.step({ version, step: "downloading", percent: want.size ? 0 : null });
      const got = await this.fetchTo(this.deps.fileUrl(want.tag, name), part, want.size, (percent) => this.step({ version, step: "downloading", percent }));

      this.step({ version, step: "verifying", percent: null });
      if (got !== sha) throw new Plain("The download doesn't match its checksum, so nothing was installed. Try again.");
      chmodSync(part, 0o755);
      if (this.deps.platform === "darwin") await signLikeTheInstaller(run, part);
      const said = await run([part, "version"], 20_000);
      const inside = said?.code === 0 ? said.out.trim().split("\n")[0].replace(/[^\w.+-]/g, "").slice(0, 30) : "";
      if (inside !== version) throw new Plain(inside ? `The download says it's Crosstalk ${inside}, not ${version}, so nothing was installed.` : `The download of Crosstalk ${version} doesn't run on this machine, so nothing was installed.`);

      renameSync(part, nextBuildPath(path));
      pruneBackups(path);
      log.info(`Crosstalk ${version} is downloaded and checked. It waits beside the running one.`);
      this.job = null;
      await this.deps.staged();
      this.say();
    } catch (e) {
      try {
        rmSync(part, { force: true });
      } catch {
        // It's cleared when the hub next starts.
      }
      if (this.stopped) return;
      const why = e instanceof Plain ? e.message : wordsFor(e);
      log.warn(`the update${version ? ` to ${version}` : ""} wasn't installed: ${e instanceof Error ? e.message : String(e)}`);
      this.step({ version, step: "failed", percent: null, error: why });
    }
  }

  private async text(url: string): Promise<string> {
    const res = await fetch(checked(url), { headers: AGENT, signal: AbortSignal.any([this.abort!.signal, AbortSignal.timeout(20_000)]) });
    if (!res.ok) throw new Plain(res.status === 404 ? "That release's files aren't on GitHub (yet). Try again in a few minutes." : `GitHub answered ${res.status} for the update. Try again in a few minutes.`);
    const text = await res.text();
    if (text.length > 1024 * 1024) throw new Plain("The release's list of checksums isn't one, so nothing was downloaded.");
    return text;
  }

  /** Downloads to `file` and returns its SHA-256. `listed`: the size the release gave, when the answer has none. */
  private async fetchTo(url: string, file: string, listed: number | null, progress: (percent: number) => void): Promise<string> {
    const abort = this.abort!;
    let stalled = false;
    let stall: ReturnType<typeof setTimeout> | undefined;
    const alive = () => {
      clearTimeout(stall);
      stall = setTimeout(() => {
        stalled = true;
        abort.abort();
      }, this.deps.stallMs ?? STALL_MS);
    };
    let fd: number | null = null;
    try {
      alive();
      // As it is on the server, so the size it gives is the size that arrives.
      const res = await fetch(checked(url), { headers: { ...AGENT, "Accept-Encoding": "identity" }, signal: abort.signal });
      if (!res.ok || !res.body) throw new Plain(res.status === 404 ? "That release's files aren't on GitHub (yet). Try again in a few minutes." : `GitHub answered ${res.status} for the download. Try again in a few minutes.`);
      const total = Number(res.headers.get("content-length")) || listed || 0;
      const hash = new Bun.CryptoHasher("sha256");
      fd = openSync(file, "w", 0o600);
      let got = 0;
      let said = -1;
      for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
        alive();
        got += chunk.byteLength;
        if (got > MAX_BYTES) throw new Plain("The download is far bigger than Crosstalk is, so it was stopped.");
        hash.update(chunk);
        writeSync(fd, chunk);
        const percent = total ? Math.min(99, Math.floor((got / total) * 100)) : -1;
        if (percent > said) progress((said = percent));
      }
      if (total && got < total) throw new Plain("The download stopped part way. Try again.");
      return hash.digest("hex");
    } catch (e) {
      if (stalled) throw new Plain("The download stopped arriving, so it was given up. Try again.");
      throw e;
    } finally {
      clearTimeout(stall);
      if (fd !== null) closeSync(fd);
    }
  }

  /** Devices hear only when what they show would change. */
  private say() {
    if (this.stopped) return;
    const said = JSON.stringify(this.brief());
    if (said === this.lastSaid) return;
    this.lastSaid = said;
    this.deps.changed();
  }
}

/**
 * Each update leaves the version that ran beside the program, to go back to (setup/system.ts takeNextBuild). With
 * updates a tap away they'd pile up, a whole program each: only the newest of them stays (and the one that runs now
 * joins it as the update starts). Files that aren't `<program>.bak-<version>` are nobody's to remove here.
 */
export function pruneBackups(path: string, keep = 1) {
  const prefix = `${basename(path)}.bak-`;
  try {
    const versions = readdirSync(dirname(path))
      .filter((n) => n.startsWith(prefix) && compareVersions(n.slice(prefix.length), "0.0.0") !== null)
      .map((n) => n.slice(prefix.length))
      .sort((a, b) => compareVersions(b, a)!);
    for (const v of versions.slice(keep)) rmSync(join(dirname(path), prefix + v), { force: true });
  } catch {
    // They stay: it's only disk space.
  }
}

/** A failure that isn't one of ours, in words: the disk, or the connection. */
function wordsFor(e: unknown): string {
  const code = (e as { code?: string } | null)?.code;
  if (code === "ENOSPC") return "This machine's disk is full, so the update couldn't be downloaded.";
  if (code === "EACCES" || code === "EPERM" || code === "EROFS") return "Crosstalk can't write to the folder its program is in, so it can't update itself. Run the installer again to update.";
  return "The download didn't finish: the connection to GitHub was lost. Try again.";
}

/**
 * What deploy/install-macos.sh does to a new program on a Mac: quarantine cleared, then signed as com.crosstalk.hub with
 * the Mac's own signing identity when it has one (macOS then keeps what Crosstalk may open across updates), else ad hoc
 * (Apple silicon runs nothing unsigned).
 */
export async function signLikeTheInstaller(run: Run, file: string): Promise<void> {
  await run(["/usr/bin/xattr", "-c", file], 10_000);
  const ids = await run(["/usr/bin/security", "find-identity", "-v", "-p", "codesigning"], 10_000);
  const line = ids?.code === 0 ? ids.out.split("\n").find((l) => /Apple Development|Developer ID Application/.test(l)) : undefined;
  const identity = line?.split('"')[1] || null;
  const sign = (as: string) => run(["/usr/bin/codesign", "--force", "--sign", as, "--identifier", "com.crosstalk.hub", file], 60_000);
  if (identity && (await sign(identity))?.code === 0) return;
  await sign("-");
}
