// BrowserOS neo (github.com/browseros-ai/BrowserOS, AGPL-3.0): the person's browser for agents. This module is what
// the setup checklist's `browseros` item reads, and what installs or updates it when they ask. Everything that touches
// the network, the disk or another program goes through `deps`, so every path here is tested from fixtures and no test
// downloads 165 MB, mounts a disk image or reaches GitHub.
//
// Three things decide everything below:
//
//  1. **The newest tag is almost never the browser.** The repo publishes near-daily releases for its own pieces
//     (`ext-browserclaw/`, `claw-server/`, `claw-onboard/`) that carry no installer at all, and the browser's own
//     releases (`browserclaw/vX.Y.Z.W`) come every week or two. So GitHub's `releases/latest`, and "the first entry of
//     the releases list", both give the wrong thing nearly every day. We pick **the newest release that actually has an
//     asset this machine can install**, and never trust a tag to say what is in it.
//  2. **A release's assets don't all carry its tag's version.** For example, `browserclaw/v0.51.2.3` carries
//     seven 0.51.2.3 installers *and* `BrowserOS_neo_v0.51.2.4_x64_installer.exe`, while `browserclaw/v0.51.2.4`
//     carries only that Windows installer. So a build's version comes from **the asset's own file name**, with the tag
//     only as a fallback — otherwise a Windows machine would be told it has 0.51.2.3 when it is running 0.51.2.4.
//  3. **The right build genuinely differs per machine.** At one point the newest Windows build was 0.51.2.4 and the
//     newest macOS and Linux build was 0.51.2.3. Picking per platform is not tidiness; a naive "latest tag" offers
//     macOS an update that has no dmg in it.
//
// Nothing here ever removes the person's profile or their data: that lives beside the app (`~/Library/Application
// Support/BrowserClaw` on a Mac), is never read for its contents, and is never touched. Replacing a copy that is
// running would throw away whatever they have open in it, so that is refused unless they say to do it anyway — and
// "is it running" is asked of **the bundle's own process**, with anything we can't tell counting as running, because
// the pid beside the browser's config belongs to a helper that can be down while the browser is up. Nothing that
// suggests a command ever pre-arms `--replace-running`: saying so is the person's, each time.

import { createHash } from "node:crypto";
import { once } from "node:events";
import { createWriteStream, existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync } from "node:fs";
import { homedir, platform as osPlatform, arch as osArch, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { diskSpace } from "./storage";
import { diskReserve } from "./uploads";
import { logger } from "./util/log";

const log = logger("browseros");

/** The repository the browser is released from (AGPL-3.0). */
export const BROWSEROS_REPO = "browseros-ai/BrowserOS";
/**
 * Its releases, newest tag first. One page is plenty: the browser ships far more often than 100 releases apart.
 * `CROSSTALK_GITHUB_API` points this at a stand-in, the way the model pool's llama.cpp releases already do, so no
 * test and no browser-suite hub ever asks the real GitHub (and no test spends the person's 60 checks an hour).
 */
export const releasesUrl = () => `${(process.env.CROSSTALK_GITHUB_API ?? "https://api.github.com").replace(/\/+$/, "")}/repos/${BROWSEROS_REPO}/releases?per_page=100`;
/** What the browser's own MCP server calls itself (`serverInfo.name`), and the name we give its entry in an agent. */
export const MCP_SERVER_NAME = "browseros-neo";
/** The app on a Mac, and the folder its profile lives in. */
export const MAC_APP_NAME = "BrowserOS neo.app";
export const PROFILE_DIR_NAME = "BrowserClaw";
/**
 * The bundle id this browser's app really has (read off an installed copy). Nothing else is installed:
 * the signature check only says an app is signed and notarised by *someone*, and the app's name comes out of the disk
 * image, so the id is the only thing that says the image holds BrowserOS neo and not another browser.
 */
export const BROWSEROS_BUNDLE_ID = "com.browseros.BrowserClaw";

// ---- what GitHub gives back ----

/** One file on a release. Only the fields we read; anything else GitHub sends is ignored. */
export interface GithubAsset {
  name?: unknown;
  browser_download_url?: unknown;
  size?: unknown;
  /** "sha256:<hex>" — GitHub's own digest of the file it will serve. Older payloads have none. */
  digest?: unknown;
  /** "uploaded" once the file is really there; an upload still in flight is not. */
  state?: unknown;
}

export interface GithubRelease {
  tag_name?: unknown;
  draft?: unknown;
  prerelease?: unknown;
  published_at?: unknown;
  created_at?: unknown;
  assets?: unknown;
}

// ---- which build this machine needs ----

export type InstallKind = "dmg" | "deb" | "appimage" | "exe";

/** One asset file name ending that fits this machine, with how it would be installed. */
export interface Want {
  /** The end of the asset's name, matched case-insensitively ("_arm64.dmg"). */
  ending: string;
  kind: InstallKind;
  /** Said in the item and the fix when this is the one that was picked. */
  note?: string;
}

/** What this machine can install, best first. Empty `wants`: nothing here fits, and `blocked` says why in plain words. */
export interface BuildTarget {
  platform: string;
  arch: string;
  wants: Want[];
  blocked: string | null;
}

/** What a Linux box has to work with (read by the probe; both false is a real machine, not a mistake). */
export interface LinuxWays {
  /** dpkg is there, so a .deb can be installed. */
  dpkg: boolean;
  /** FUSE is there, so an AppImage runs by itself. Without it one still runs, unpacked — see below. */
  fuse: boolean;
}

/**
 * The builds that fit this machine, best first.
 *
 * On a Mac the **arch-native dmg comes before the universal one**: on 2026-10-23 the arm64 dmg was 165 MB and the
 * universal 304 MB, so taking the universal build would download and keep nearly twice as much for the same browser.
 * The universal dmg is still listed, so a release that ships only that one is installable instead of being reported as
 * "no build for this machine".
 *
 * On Linux a .deb is better where `dpkg` exists. **Where it doesn't, the AppImage is still the answer, even with no
 * FUSE**: an AppImage runs unpacked with `--appimage-extract-and-run`, which needs no FUSE and no root. So a box with
 * neither dpkg nor FUSE is not blocked — it gets the AppImage with a note saying how it has to be started. The one
 * machine that really has nothing to install is one whose platform the browser has no asset for at all.
 */
export function buildTarget(platform: string = osPlatform(), arch: string = osArch(), linux: LinuxWays = { dpkg: false, fuse: false }): BuildTarget {
  const t = (wants: Want[], blocked: string | null = null): BuildTarget => ({ platform, arch, wants, blocked });
  if (platform === "darwin") {
    if (arch === "arm64") return t([{ ending: "_arm64.dmg", kind: "dmg" }, { ending: "_universal.dmg", kind: "dmg", note: "This release has no Apple-silicon-only build, so it's the universal one: the same browser, about twice the download." }]);
    if (arch === "x64") return t([{ ending: "_x64.dmg", kind: "dmg" }, { ending: "_universal.dmg", kind: "dmg", note: "This release has no Intel-only build, so it's the universal one: the same browser, about twice the download." }]);
    return t([], `BrowserOS neo has no Mac build for ${arch}.`);
  }
  if (platform === "linux") {
    const deb: Want = arch === "arm64" ? { ending: "_arm64.deb", kind: "deb" } : { ending: "_amd64.deb", kind: "deb" };
    const image: Want = arch === "arm64" ? { ending: "_arm64.AppImage", kind: "appimage" } : { ending: "_x64.AppImage", kind: "appimage" };
    if (arch !== "x64" && arch !== "arm64") return t([], `BrowserOS neo has no Linux build for ${arch}.`);
    // No FUSE isn't a dead end: the note says how it starts. It is the AppImage either way, so nothing here refuses.
    const withNote: Want = linux.fuse ? image : { ...image, note: "This machine has no FUSE, so start it unpacked: BrowserOS_neo*.AppImage --appimage-extract-and-run" };
    return linux.dpkg ? t([deb, withNote]) : t([withNote]);
  }
  if (platform === "win32") {
    if (arch === "x64") return t([{ ending: "_x64_installer.exe", kind: "exe", note: "The installer runs on the machine itself: Crosstalk downloads and checks it, you run it." }]);
    return t([], `BrowserOS neo has no Windows build for ${arch}.`);
  }
  return t([], `BrowserOS neo has no build for ${platform}.`);
}

// ---- picking the build ----

export interface PickedAsset {
  name: string;
  url: string;
  size: number | null;
  /** The hex SHA-256 GitHub reports for this file, or null when its payload carries none. */
  sha256: string | null;
}

export interface Build {
  /** The release it came from ("browserclaw/v0.51.2.3"): for the words, never for the version. */
  tag: string;
  /** The build's own version, from the asset's file name (see the header), tag as a fallback. */
  version: string;
  asset: PickedAsset;
  kind: InstallKind;
  publishedAt: number;
  note?: string;
}

/** "BrowserOS_neo_v0.51.2.3_arm64.dmg" → "0.51.2.3". Null when the name carries no version. */
export function versionInName(name: string): string | null {
  const m = /_v(\d+(?:\.\d+)*)[._]/i.exec(name);
  return m ? m[1] : null;
}

/** "browserclaw/v0.51.2.4" → "0.51.2.4". Null when the tag carries no version. */
export function versionInTag(tag: string): string | null {
  const m = /v(\d+(?:\.\d+)*)\s*$/i.exec(tag);
  return m ? m[1] : null;
}

/** Dotted versions of any length, compared number by number ("0.51.2.10" is above "0.51.2.9"). */
export function compareVersions(a: string, b: string): number {
  const x = a.split(".").map((n) => Number.parseInt(n, 10) || 0);
  const y = b.split(".").map((n) => Number.parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    const d = (x[i] ?? 0) - (y[i] ?? 0);
    if (d) return d < 0 ? -1 : 1;
  }
  return 0;
}

/** `b` is above `a` — "is this build newer than what's installed". An unknown `a` counts as older, so a copy whose
 * version nothing could read is offered the update rather than quietly called up to date. */
export const newerVersion = (a: string | null, b: string | null) => !!b && (!a || compareVersions(b, a) > 0);

const str = (v: unknown) => (typeof v === "string" ? v : "");
const digestHex = (v: unknown) => {
  const m = /^sha256:([0-9a-f]{64})$/i.exec(str(v).trim());
  return m ? m[1].toLowerCase() : null;
};

/**
 * The newest build this machine can install, out of every release in the payload.
 *
 * Releases are ranked by the **version of the asset that fits**, not by the tag and not by the order GitHub sent them
 * in (that list is ordered by when each tag was created, so a sub-component release made yesterday sits above a browser
 * release published today). Same version in two releases: the one published later wins, then the better-fitting asset.
 * Drafts and assets still uploading are skipped — a half-uploaded file would fail its own checksum anyway, so it is
 * better to offer nothing than to offer that.
 *
 * **Prereleases are not "the newest build" either.** GitHub's `/releases` list carries them, so a
 * `browserclaw/vX.Y.Z.W` marked prerelease with a dmg in it would otherwise be offered as an update to someone on a
 * stable install. Stable wins; a prerelease is taken only when no stable release has an asset for this machine at
 * all — better than telling a machine there is no build — and then the note says what it is.
 */
export function pickBuild(payload: unknown, target: BuildTarget): Build | null {
  if (!Array.isArray(payload) || !target.wants.length) return null;
  return scanReleases(payload, target, false) ?? scanReleases(payload, target, true);
}

/** Said on a build that came from a prerelease, so nobody takes one without knowing. */
export const PRERELEASE_NOTE = "This is a prerelease: it's the only build BrowserOS neo has for this machine right now.";

function scanReleases(payload: unknown[], target: BuildTarget, prereleases: boolean): Build | null {
  let best: Build | null = null;
  for (const raw of payload) {
    const r = (raw && typeof raw === "object" ? raw : {}) as GithubRelease;
    if (r.draft === true) continue;
    const pre = r.prerelease === true;
    if (pre && !prereleases) continue;
    const tag = str(r.tag_name);
    const assets = Array.isArray(r.assets) ? (r.assets as GithubAsset[]) : [];
    const when = Date.parse(str(r.published_at) || str(r.created_at));
    const publishedAt = Number.isFinite(when) ? when : 0;
    for (let rank = 0; rank < target.wants.length; rank++) {
      const want = target.wants[rank];
      const found = assets.find((a) => {
        const name = str(a.name);
        const state = str(a.state);
        return name.toLowerCase().endsWith(want.ending.toLowerCase()) && str(a.browser_download_url) !== "" && (state === "" || state === "uploaded");
      });
      if (!found) continue;
      const name = str(found.name);
      // The asset's own name first: a release can carry a newer build's installer than its tag claims (header, point 2).
      const version = versionInName(name) ?? versionInTag(tag);
      if (!version) continue;
      const note = [want.note, pre ? PRERELEASE_NOTE : null].filter(Boolean).join(" ");
      const build: Build = {
        tag,
        version,
        asset: { name, url: str(found.browser_download_url), size: typeof found.size === "number" && found.size > 0 ? found.size : null, sha256: digestHex(found.digest) },
        kind: want.kind,
        publishedAt,
        ...(note ? { note } : {}),
      };
      if (!best || betterBuild(build, best, target)) best = build;
      // The wants are best-first, so once this release has given one, its worse ones can't beat it.
      break;
    }
  }
  return best;
}

/** Newer version first, then published later, then the better-fitting asset (native dmg over universal). */
function betterBuild(a: Build, b: Build, target: BuildTarget): boolean {
  const v = compareVersions(a.version, b.version);
  if (v !== 0) return v > 0;
  if (a.publishedAt !== b.publishedAt) return a.publishedAt > b.publishedAt;
  const rank = (x: Build) => target.wants.findIndex((w) => x.asset.name.toLowerCase().endsWith(w.ending.toLowerCase()));
  return rank(a) < rank(b);
}

// ---- asking GitHub ----

/** What the releases call gave back. Everything that isn't a list of releases says what to do instead. */
export type ReleasesResult =
  | { ok: true; releases: unknown[] }
  | { ok: false; why: "offline" | "rate" | "http" | "bad"; detail: string; retryAt?: number };

export interface FetchDeps {
  get?: typeof fetch;
  now?: () => number;
}

/** An answer is reused this long. The browser ships every week or two, so asking more often only spends the allowance. */
export const RELEASES_TTL_MS = 6 * 3600_000;
/** And a failed ask this long, so a hub that checks its list every few seconds can't hammer GitHub while it's down. */
export const RELEASES_FAIL_TTL_MS = 10 * 60_000;

let releasesCache: { until: number; result: ReleasesResult } | null = null;

/** Tests, and anything that wants the next ask to really happen. */
export function forgetReleases(): void {
  releasesCache = null;
}

/**
 * The releases, asked at most once every few hours. The setup checklist is worked out again whenever anything on the
 * machine changes, and an agent may ask for it in a loop: without this, 60 checks an hour would be gone in minutes.
 * A used-up allowance is held exactly until GitHub says it comes back, so the next ask isn't wasted either.
 */
export async function cachedReleases(deps: FetchDeps = {}): Promise<ReleasesResult> {
  const now = deps.now?.() ?? Date.now();
  if (releasesCache && releasesCache.until > now) return releasesCache.result;
  const result = await fetchReleases(deps);
  const until = result.ok ? now + RELEASES_TTL_MS : result.why === "rate" && result.retryAt && result.retryAt > now ? result.retryAt : now + RELEASES_FAIL_TTL_MS;
  releasesCache = { until, result };
  return result;
}

/**
 * The releases, unauthenticated. GitHub allows 60 such calls an hour per address, and **a used-up allowance comes back
 * as 403, not 429**, with `x-ratelimit-remaining: 0` and `x-ratelimit-reset` (unix seconds) saying when it resets — so
 * it is told apart from a real refusal by those headers, and the words say the time instead of "try again later".
 */
export async function fetchReleases(deps: FetchDeps = {}): Promise<ReleasesResult> {
  const get = deps.get ?? fetch;
  let r: Response;
  try {
    r = await get(releasesUrl(), {
      signal: AbortSignal.timeout(10_000),
      headers: { accept: "application/vnd.github+json", "x-github-api-version": "2022-11-28", "user-agent": "crosstalk-hub" },
    });
  } catch (e) {
    return { ok: false, why: "offline", detail: e instanceof Error ? e.message : String(e) };
  }
  if (!r.ok) {
    const remaining = r.headers.get("x-ratelimit-remaining");
    const reset = Number(r.headers.get("x-ratelimit-reset"));
    if ((r.status === 403 || r.status === 429) && (remaining === "0" || r.headers.get("retry-after"))) {
      const after = Number(r.headers.get("retry-after"));
      const retryAt = Number.isFinite(reset) && reset > 0 ? reset * 1000 : Number.isFinite(after) && after > 0 ? (deps.now?.() ?? Date.now()) + after * 1000 : undefined;
      return { ok: false, why: "rate", detail: `GitHub allows 60 unsigned checks an hour and this one is used up (${r.status}).`, ...(retryAt ? { retryAt } : {}) };
    }
    return { ok: false, why: "http", detail: `GitHub answered ${r.status}.` };
  }
  let body: unknown;
  try {
    body = await r.json();
  } catch {
    return { ok: false, why: "bad", detail: "GitHub's answer wasn't the releases list." };
  }
  if (!Array.isArray(body)) return { ok: false, why: "bad", detail: "GitHub's answer wasn't the releases list." };
  return { ok: true, releases: body };
}

// ---- what's installed here ----

export interface Installed {
  /** The app bundle, the unpacked folder or the AppImage file. */
  path: string;
  /** From the bundle's Info.plist, the package manager or the file name; null when none of them said. */
  version: string | null;
  bundleId: string | null;
  kind: InstallKind;
  /** Its own process is up: replacing it now would throw away whatever they have open. */
  running: boolean;
}

/** Running a program quietly, with stderr kept: `codesign` and `spctl` say what they found on stderr, not stdout. */
export type RunBoth = (args: string[], timeoutMs?: number) => Promise<{ code: number; out: string; err: string } | null>;

export interface SystemDeps {
  run?: RunBoth;
  home?: string;
  platform?: string;
  arch?: string;
  exists?: (path: string) => boolean;
  read?: (path: string) => string | null;
  /** Whether a pid is alive, without signalling it. */
  alive?: (pid: number) => boolean;
  /** The clock the caches here use. Tests move it; nothing else sets it. */
  now?: () => number;
}

const defaults = (d: SystemDeps) => ({
  run: d.run ?? runBoth,
  home: d.home ?? homedir(),
  platform: d.platform ?? osPlatform(),
  arch: d.arch ?? osArch(),
  exists: d.exists ?? ((p: string) => existsSync(p)),
  read: d.read ?? readTextFile,
  alive: d.alive ?? isAlive,
});

export function readTextFile(path: string): string | null {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return null;
  }
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    // A pid owned by someone else answers EPERM, which still means it is there.
    return (e as { code?: string }).code === "EPERM";
  }
}

/** Where the browser keeps its profile and its own state file. Never read for its contents, never written, never removed. */
export function profileDir(d: SystemDeps = {}): string {
  const { home, platform } = defaults(d);
  if (platform === "darwin") return join(home, "Library", "Application Support", PROFILE_DIR_NAME);
  if (platform === "win32") return join(process.env.LOCALAPPDATA || join(home, "AppData", "Local"), PROFILE_DIR_NAME, "User Data");
  return join(home, ".config", PROFILE_DIR_NAME);
}

/** The browser's own small state folder inside the profile: its ports and the pid of the server it started. */
export const stateDir = (d: SystemDeps = {}) => join(profileDir(d), ".browseros");

/** What `.browseros/config.json` says, as far as we read it. Null: it isn't there, or it isn't JSON. */
export function readBrowserConfig(d: SystemDeps = {}): { ports: Record<string, number>; version: string | null } | null {
  const { read } = defaults(d);
  const text = read(join(stateDir(d), "config.json"));
  if (!text) return null;
  try {
    const j = JSON.parse(text) as { ports?: Record<string, unknown>; instance?: { browseros_version?: unknown } };
    const ports: Record<string, number> = {};
    for (const [k, v] of Object.entries(j.ports ?? {})) if (typeof v === "number" && v > 0 && v < 65536) ports[k] = v;
    return { ports, version: typeof j.instance?.browseros_version === "string" ? j.instance.browseros_version : null };
  } catch {
    return null;
  }
}

/**
 * Whether the browser's **MCP helper** is up, from the pid it wrote beside its config.
 *
 * This is not "the browser is open", and must never be used as that: in one measurement the browser was
 * pid 72259 (`/Applications/BrowserOS neo.app/Contents/MacOS/BrowserOS neo`) while `server.state` held 72345, the
 * separate `browseros-claw-server` helper. The helper can be down while the browser is up — it crashed, a build
 * started it on demand, `flags.allow_remote_in_mcp` is off — and a profile other than the default writes no state file
 * at all. So this is one signal; `browserRunning` below is the question that decides whether a bundle may be replaced.
 */
export function serverRunning(d: SystemDeps = {}): boolean {
  const { read, alive } = defaults(d);
  const text = read(join(stateDir(d), "server.state"));
  if (!text) return false;
  try {
    const pid = (JSON.parse(text) as { pid?: unknown }).pid;
    return typeof pid === "number" && pid > 0 && alive(pid);
  } catch {
    return false;
  }
}

/** Whether a copy is open, and whether we really know. `sure: false`: the process list couldn't be asked. */
export interface RunningCheck {
  running: boolean;
  sure: boolean;
}

/** Regex metacharacters quoted, so a path goes to `pgrep -f` (an extended regex) as the literal text it is. */
const reEscape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * Whether **the app at `path` is running** — the browser itself, not a helper beside it.
 *
 * Asked of the process list, about the bundle's own executable folder: on a Mac the browser's argv[0] is
 * `<bundle>/Contents/MacOS/…`, while its helper lives under `Contents/Resources/` and its renderers under
 * `Contents/Frameworks/`, so this pattern picks out the browser and nothing else. `server.state` stays as an extra
 * signal for when pgrep finds nothing (a browser started from another bundle still writes that file).
 *
 * `sure` is false when pgrep couldn't be run or answered something other than "found" / "none found". Callers that are
 * about to delete the bundle treat that as running: refusing an update is a minute of the person's time, pulling the
 * Frameworks out from under a live Chromium loses their tabs.
 */
export async function browserRunning(path: string, d: SystemDeps = {}): Promise<RunningCheck> {
  const dd = defaults(d);
  // Windows installs are run by the person, never replaced from here, so there is nothing to guard and no pgrep.
  if (dd.platform === "win32") return { running: serverRunning(d), sure: true };
  const pattern = dd.platform === "darwin" ? `${path}/Contents/MacOS/` : path;
  const r = await dd.run(["/usr/bin/pgrep", "-f", reEscape(pattern)], 5000);
  // pgrep: 0 found something, 1 found nothing, anything else (and no answer at all) means we couldn't tell.
  if (r && r.code === 0) return { running: true, sure: true };
  const helper = serverRunning(d);
  if (r && r.code === 1) return { running: helper, sure: true };
  return { running: helper, sure: false };
}

/** Where the app can be: the shared folder first, then the person's own. */
export function appPaths(d: SystemDeps = {}): string[] {
  const { home, platform } = defaults(d);
  if (platform === "darwin") return [join("/Applications", MAC_APP_NAME), join(home, "Applications", MAC_APP_NAME)];
  if (platform === "win32") return [join(process.env.LOCALAPPDATA || join(home, "AppData", "Local"), "BrowserOS neo", "browseros-neo.exe")];
  return [join(home, ".local", "opt", "browseros-neo", "AppRun"), "/opt/browseros-neo/browseros-neo", "/usr/bin/browseros-neo", join(home, "Applications", "BrowserOS_neo.AppImage")];
}

/**
 * The copy installed on this machine, or null. The version comes from the bundle's own Info.plist on a Mac (`plutil`,
 * because an app's Info.plist is binary), from the package on a Linux .deb install, and from the browser's own
 * `config.json` otherwise — which is also the cross-check: a bundle whose plist can't be read still reports a version
 * when the browser has run once here.
 */
export async function readInstalled(d: SystemDeps = {}): Promise<Installed | null> {
  const dd = defaults(d);
  const path = appPaths(d).find((p) => dd.exists(p));
  const config = readBrowserConfig(d);
  if (!path) return null;
  // What the item says ("It's open now") is what we really saw; the install guard is stricter (browserRunning).
  const running = (await browserRunning(path, d)).running;
  if (dd.platform === "darwin") {
    const plist = await macPlist(join(path, "Contents", "Info.plist"), dd.run);
    return { path, version: plist.version ?? config?.version ?? null, bundleId: plist.bundleId, kind: "dmg", running };
  }
  if (dd.platform === "win32") return { path, version: config?.version ?? null, bundleId: null, kind: "exe", running };
  const deb = path.startsWith("/opt/") || path.startsWith("/usr/");
  const fromName = versionInName(path);
  return { path, version: config?.version ?? fromName ?? null, bundleId: null, kind: deb ? "deb" : "appimage", running };
}

/** An app bundle's short version and bundle id. An Info.plist inside a bundle is binary, so `plutil` reads it. */
async function macPlist(file: string, run: RunBoth): Promise<{ version: string | null; bundleId: string | null }> {
  const r = await run(["/usr/bin/plutil", "-convert", "json", "-o", "-", file], 5000);
  if (!r || r.code !== 0) return { version: null, bundleId: null };
  try {
    const j = JSON.parse(r.out) as { CFBundleShortVersionString?: unknown; CFBundleIdentifier?: unknown };
    return {
      version: typeof j.CFBundleShortVersionString === "string" ? j.CFBundleShortVersionString : null,
      bundleId: typeof j.CFBundleIdentifier === "string" ? j.CFBundleIdentifier : null,
    };
  } catch {
    return { version: null, bundleId: null };
  }
}

/** What a Linux box has: dpkg for a .deb, FUSE for an AppImage that runs without being unpacked. */
export async function linuxWays(d: SystemDeps = {}): Promise<LinuxWays> {
  const dd = defaults(d);
  if (dd.platform !== "linux") return { dpkg: false, fuse: false };
  const r = await dd.run(["/usr/bin/env", "sh", "-c", "command -v dpkg >/dev/null 2>&1 && echo dpkg; { [ -e /dev/fuse ] || command -v fusermount >/dev/null 2>&1 || command -v fusermount3 >/dev/null 2>&1; } && echo fuse"], 5000);
  const out = r?.out ?? "";
  return { dpkg: out.includes("dpkg"), fuse: out.includes("fuse") };
}

// ---- its MCP endpoint ----

export interface McpEndpoint {
  url: string;
  port: number;
  /** Which port of the browser's own config it was ("proxy" is the one the browser puts in an agent's settings). */
  from: string;
  serverName: string | null;
  serverVersion: string | null;
}

export interface McpDeps extends SystemDeps {
  get?: typeof fetch;
}

/** An endpoint that answered is reused this long: the probe talks to a browser the person is working in. */
export const MCP_TTL_MS = 10 * 60_000;
/** And nothing answering this long, so a hub whose checklist is asked for every few seconds isn't knocking either. */
export const MCP_FAIL_TTL_MS = 30_000;

let mcpCache: { key: string; until: number; found: McpEndpoint | null } | null = null;

/** Tests, and anything that wants the next look to really ask. */
export function forgetMcp(): void {
  mcpCache = null;
}

/**
 * The browser's MCP endpoint, **found, never assumed**. Its own docs say the port moves between builds, and it does:
 * build 0.51.2.3 serves MCP on 9010 (its proxy) and 9210 (its server), while an older note said 9200. So the
 * ports come out of the browser's own `config.json` and each is asked who it is; nothing is hard-coded and no range is
 * scanned. The proxy port goes first because that is the one the browser itself writes into an agent's settings.
 *
 * The answer is **kept**, keyed on the ports the browser wrote down: the checklist is worked out again every few
 * seconds while an agent polls it, and each probe is a real MCP `initialize` in a browser the person has their work in.
 * A new build writes new ports, which changes the key and asks again; nothing answering is only kept for half a minute.
 *
 * Null when the browser has never run here (no config) or nothing answered: the item then says to open it once.
 */
export async function discoverMcp(d: McpDeps = {}): Promise<McpEndpoint | null> {
  const get = d.get ?? fetch;
  const now = d.now?.() ?? Date.now();
  const config = readBrowserConfig(d);
  if (!config) return null;
  const key = `${stateDir(d)}\n${JSON.stringify(config.ports)}`;
  if (mcpCache && mcpCache.key === key && mcpCache.until > now) return mcpCache.found;
  const order = ["proxy", "server", "mcp"];
  const ports = Object.entries(config.ports).sort((a, b) => {
    const ra = order.indexOf(a[0]);
    const rb = order.indexOf(b[0]);
    return (ra < 0 ? order.length : ra) - (rb < 0 ? order.length : rb);
  });
  let found: McpEndpoint | null = null;
  for (const [from, port] of ports) {
    // The browser's CDP port is a debugger, not an MCP server: asking it nothing useful, so it is left alone.
    if (from === "cdp") continue;
    const url = `http://127.0.0.1:${port}/mcp`;
    const who = await mcpHello(url, get);
    if (who) {
      found = { url, port, from, serverName: who.name, serverVersion: who.version };
      break;
    }
  }
  mcpCache = { key, until: now + (found ? MCP_TTL_MS : MCP_FAIL_TTL_MS), found };
  return found;
}

/**
 * One MCP `initialize`, which is the cheapest honest way to ask a port who it is. Null: it isn't an MCP server.
 *
 * A server that answers with an `mcp-session-id` is then told we are done with it, because that is all this was: the
 * hub never uses this session, and a browser the person works in shouldn't collect a half-open one per check.
 */
async function mcpHello(url: string, get: typeof fetch): Promise<{ name: string | null; version: string | null } | null> {
  try {
    const r = await get(url, {
      method: "POST",
      signal: AbortSignal.timeout(4000),
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "crosstalk-hub", version: "setup" } } }),
    });
    if (!r.ok) return null;
    const session = r.headers.get("mcp-session-id");
    const text = (await r.text()).slice(0, 64_000);
    const info = serverInfo(text);
    if (session) await endSession(url, session, get);
    return info && info.name ? info : null;
  } catch {
    return null;
  }
}

/** The session this probe opened, closed again. Best effort: nothing here depends on it, so nothing waits long. */
async function endSession(url: string, session: string, get: typeof fetch): Promise<void> {
  try {
    await get(url, { method: "DELETE", signal: AbortSignal.timeout(2000), headers: { "mcp-session-id": session, accept: "application/json, text/event-stream" } });
  } catch {
    // It only had to be asked; a server that won't forget us is no reason to report the browser as unreachable.
  }
}

/** `serverInfo` out of an MCP answer, which comes back as JSON or as one `data:` line of an event stream. */
export function serverInfo(text: string): { name: string | null; version: string | null } | null {
  const bodies = [text, ...text.split("\n").filter((l) => l.startsWith("data:")).map((l) => l.slice(5).trim())];
  for (const body of bodies) {
    if (!body.startsWith("{")) continue;
    try {
      const j = JSON.parse(body) as { result?: { serverInfo?: { name?: unknown; version?: unknown } } };
      const s = j.result?.serverInfo;
      if (s) return { name: typeof s.name === "string" ? s.name : null, version: typeof s.version === "string" ? s.version : null };
    } catch {
      // Not this line: try the next.
    }
  }
  return null;
}

// ---- the agents' own settings ----

export type McpAgent = "claude" | "codex" | "gemini";

/** An entry in an agent's own settings that points at a BrowserOS MCP endpoint on this machine. */
export interface AgentLink {
  agent: McpAgent;
  /** The entry's name in that agent ("browseros-neo"). */
  name: string;
  url: string;
}

/** Whether a URL is an MCP endpoint on this machine (the only place this browser ever serves one). */
export function localMcpUrl(url: string): boolean {
  try {
    const u = new URL(url);
    return (u.hostname === "127.0.0.1" || u.hostname === "localhost" || u.hostname === "[::1]" || u.hostname === "::1") && u.pathname.replace(/\/+$/, "").endsWith("/mcp");
  } catch {
    return false;
  }
}

/**
 * Two addresses that reach the same MCP server. `localhost`, `::1` and `127.0.0.1` are one machine, and a trailing
 * slash means nothing — the browser's own Manual Setup page hands out `http://localhost:<port>/mcp`, and an entry
 * written that way works perfectly. Comparing the raw strings used to call it stale and nag about it forever.
 */
export function sameMcpUrl(a: string, b: string): boolean {
  const norm = (s: string) => {
    try {
      const u = new URL(s.trim());
      const host = u.hostname === "localhost" || u.hostname === "[::1]" || u.hostname === "::1" ? "127.0.0.1" : u.hostname;
      return `${u.protocol}//${host}:${u.port}${u.pathname.replace(/\/+$/, "")}`;
    } catch {
      return s.trim().replace(/\/+$/, "");
    }
  };
  return norm(a) === norm(b);
}

/** Whether an entry's name says it is this browser. The one test that holds whatever port anything points at. */
export const namesBrowser = (name: string) => /browseros|browserclaw/i.test(name);

/**
 * Each agent's user-wide entry for this browser, read from the files the agents themselves write: Claude Code
 * `~/.claude.json` `mcpServers`, Codex `~/.codex/config.toml` `[mcp_servers.<name>]` with a `url`, Gemini CLI
 * `~/.gemini/settings.json` `mcpServers`.
 *
 * An entry counts when **its name names this browser**, or when it points at `endpoint` — the address the browser
 * itself just answered on. Any *other* MCP server on 127.0.0.1 is somebody else's: taking every loopback `/mcp` for
 * this browser read an unrelated `docs: http://127.0.0.1:3000/mcp` as the agent's BrowserOS link, and the item then
 * said the browser had moved port and offered to "fix" a server that has nothing to do with it. A name that says
 * BrowserOS still counts whatever port it holds, which is what keeps a **stale port** visible instead of silently wrong.
 */
export function agentLinks(d: SystemDeps = {}, endpoint: string | null = null): AgentLink[] {
  const { home, read } = defaults(d);
  const out: AgentLink[] = [];
  const take = (agent: McpAgent, name: string, url: unknown) => {
    const u = typeof url === "string" ? url.trim() : "";
    if (!u) return;
    if (!namesBrowser(name) && !(endpoint && localMcpUrl(u) && sameMcpUrl(u, endpoint))) return;
    out.push({ agent, name, url: u });
  };
  for (const [agent, file] of [
    ["claude", join(home, ".claude.json")],
    ["gemini", join(home, ".gemini", "settings.json")],
  ] as [McpAgent, string][]) {
    const text = read(file);
    if (!text) continue;
    try {
      const servers = (JSON.parse(text) as { mcpServers?: Record<string, { url?: unknown; httpUrl?: unknown; serverUrl?: unknown }> }).mcpServers ?? {};
      for (const [name, s] of Object.entries(servers)) take(agent, name, s?.url ?? s?.httpUrl ?? s?.serverUrl);
    } catch {
      // An agent's settings we can't read tell us nothing; the item says "couldn't tell" rather than "not connected".
    }
  }
  const toml = read(join(home, ".codex", "config.toml"));
  if (toml) for (const [name, url] of tomlMcpUrls(toml)) take("codex", name, url);
  return out;
}

/** `[mcp_servers.<name>]` blocks of a Codex config and each one's `url`, without a TOML parser for three lines of it. */
export function tomlMcpUrls(text: string): [string, string][] {
  const out: [string, string][] = [];
  let name: string | null = null;
  for (const line of text.split("\n")) {
    const header = /^\s*\[(?:mcp_servers)\.([^.\]]+)\]\s*$/.exec(line);
    if (header) {
      name = header[1].replace(/^"|"$/g, "");
      continue;
    }
    if (/^\s*\[/.test(line)) {
      name = null;
      continue;
    }
    const url = name ? /^\s*url\s*=\s*"([^"]+)"/.exec(line) : null;
    if (name && url) {
      out.push([name, url[1]]);
      name = null;
    }
  }
  return out;
}

/**
 * The exact command that adds this browser to one agent, user-wide (checked against each CLI's own `mcp add --help`:
 * Claude Code 2.1.289, Codex 0.160.0, Gemini CLI 0.62.0). Codex writes its entry straight into
 * `~/.codex/config.toml` and has no scope flag.
 */
export function addCommand(agent: McpAgent, url: string): string {
  if (agent === "codex") return `codex mcp add ${MCP_SERVER_NAME} --url ${url}`;
  return `${agent} mcp add --scope user --transport http ${MCP_SERVER_NAME} ${url}`;
}

/** An entry name that goes on a command line as it is. Anything odder falls back to the name Crosstalk gives its own. */
const plainName = (name: string) => (/^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/.test(name) ? name : null);

/**
 * Taking a stale entry out again, so the right one can be added over it (Claude Code refuses a name already there).
 *
 * **`name` is the entry's real name**, not ours: the browser's own "connect your agent" page, and anyone following its
 * Manual Setup instructions, registers it as whatever they like — `browseros`, `neo`, `browserclaw`. Naming
 * `browseros-neo` there made the line a no-op (`claude mcp remove browseros-neo -s user` exits 1 with `No MCP server
 * named …`), which, joined to the add with `&&`, meant the fix never did anything at all.
 */
export function removeCommand(agent: McpAgent, name?: string): string {
  const n = (name ? plainName(name) : null) ?? MCP_SERVER_NAME;
  if (agent === "codex") return `codex mcp remove ${n}`;
  return `${agent} mcp remove ${n}${agent === "claude" ? " -s user" : " --scope user"}`;
}

/** Said wherever a command above is offered: the agent reads its servers once, when it starts. */
export const RESTART_NOTE = "The agent only picks up a new MCP server when it starts again, so close it and open it once after this.";

// ---- downloading, checking and installing ----

export type InstallFailure = "offline" | "download" | "size" | "checksum" | "no-digest" | "signature" | "notarisation" | "identity" | "mount" | "copy" | "running" | "space" | "unsupported";

/**
 * How an install ended. "installed": it is in place. "ready": the file is downloaded and checked, and the last step is
 * the person's — a .deb needs root and a Windows installer runs itself, and neither is something a hub does for them.
 * "failed": nothing was installed, and `detail` says why in words they can act on.
 */
export type InstallResult =
  | { done: "installed"; path: string; version: string; replaced: string | null }
  | { done: "ready"; file: string; command: string; detail: string }
  | { done: "failed"; why: InstallFailure; detail: string };

export interface InstallDeps extends SystemDeps {
  get?: typeof fetch;
  /** Where the half-downloaded file goes; it is removed when the install worked. */
  tmp?: string;
  /** Writing the download. Replaced in tests so nothing of this size is ever really written. */
  sink?: (path: string, body: ReadableStream<Uint8Array> | null, append: boolean) => Promise<number>;
  /** How big that file is now, for carrying on a download that died half way. */
  sizeOf?: (path: string) => number;
  /** The file's SHA-256, hex. */
  hash?: (path: string) => Promise<string>;
  remove?: (path: string) => void;
  /** Free space where the download goes. Null: the disk couldn't be measured, and nothing is refused over that. */
  space?: (dir: string) => { free: number } | null;
}

/** How many times a download that died half way is carried on from where it stopped before giving up. */
export const DOWNLOAD_TRIES = 3;

/** A size a person reads, as the pool's downloads say it. */
const gb = (n: number) => (n >= 1024 ** 3 ? `${(n / 1024 ** 3).toFixed(1)} GB` : n >= 1024 ** 2 ? `${Math.ceil(n / 1024 ** 2)} MB` : `${Math.ceil(n / 1024)} KB`);

/**
 * Room the install still needs, with `have` bytes of it already downloaded. A dmg is mounted and the bundle copied out
 * of it into /Applications, so the peak is the image **plus** about as much again; the other kinds are moved into
 * place, so the file itself is all. Zero when GitHub reported no size — then there is nothing to measure against.
 */
export function spaceNeeded(build: Build, have = 0): number {
  const size = build.asset.size ?? 0;
  if (!size) return 0;
  return Math.max(0, size - have) + (build.kind === "dmg" ? size : 0);
}

/** The nearest folder that is really there, so the disk can be measured before the download's folder is made. */
function existingDir(path: string): string {
  let p = path;
  while (!existsSync(p) && dirname(p) !== p) p = dirname(p);
  return p;
}

/** Free space where `dir` is (or will be), as far as it can be measured. Null when the disk can't be asked. */
function freeAt(dir: string, d: InstallDeps): number | null {
  const ask = d.space ?? ((p: string) => diskSpace(p));
  try {
    return ask(existingDir(dir))?.free ?? null;
  } catch {
    return null;
  }
}

/** Whatever the write said, read as "the disk filled up". */
const outOfSpace = (text: string) => /enospc|no space left|disk (is )?full/i.test(text);

/**
 * The asset, downloaded and checked. A download that dies half way is carried on with a `Range` request from the bytes
 * already on disk rather than started again (165 MB), at most `DOWNLOAD_TRIES` times in all.
 *
 * **It is refused unless GitHub reported a SHA-256 for it and the file matches**: a release payload with no `digest`
 * gives nothing to check a 165 MB download against, and installing an unchecked browser is not something to do quietly.
 *
 * **And it is refused before the first byte when the disk hasn't got room for it**, keeping the same 2 GB the hub keeps
 * free for everything else (`diskReserve`, as the model pool's downloads and uploads do). Without that, a 165-304 MB
 * asset on a nearly-full disk failed three times, each try filling what was left, and ENOSPC came out as "check the
 * network" with the hub's own reserve eaten by a dead download.
 */
export async function downloadAsset(build: Build, file: string, d: InstallDeps = {}): Promise<{ ok: true } | { ok: false; why: InstallFailure; detail: string }> {
  const get = d.get ?? fetch;
  const sink = d.sink ?? writeStream;
  const sizeOf = d.sizeOf ?? fileSize;
  const hash = d.hash ?? hashFile;
  const remove = d.remove ?? removePath;
  if (!build.asset.sha256) return { ok: false, why: "no-digest", detail: `GitHub reports no SHA-256 for ${build.asset.name}, so there's nothing to check the download against. Crosstalk won't install it.` };
  const dir = dirname(file);
  const need = spaceNeeded(build, sizeOf(file));
  const room = freeAt(dir, d);
  if (need > 0 && room !== null && room < need + diskReserve()) {
    return {
      ok: false,
      why: "space",
      detail: `Not enough free space for BrowserOS neo ${build.version}: downloading and installing it need ${gb(need)}, and ${gb(Math.max(0, room - diskReserve()))} is free (keeping ${gb(diskReserve())} free). Free up space on this machine, then try again.`,
    };
  }
  let last = "";
  for (let attempt = 1; attempt <= DOWNLOAD_TRIES; attempt++) {
    const have = sizeOf(file);
    // More on disk than the whole file: what's there isn't this download. Start it again.
    if (build.asset.size !== null && have > build.asset.size) {
      remove(file);
      continue;
    }
    try {
      const r = await get(build.asset.url, {
        redirect: "follow",
        signal: AbortSignal.timeout(30 * 60_000),
        headers: { accept: "application/octet-stream", "user-agent": "crosstalk-hub", ...(have > 0 ? { range: `bytes=${have}-` } : {}) },
      });
      // 206: it carried on. 200 with a Range asked for: it ignored the ask and is sending the lot, so start over.
      if (r.status !== 200 && r.status !== 206) {
        last = `GitHub answered ${r.status}.`;
        continue;
      }
      const append = have > 0 && r.status === 206;
      if (have > 0 && !append) remove(file);
      await sink(file, r.body, append);
    } catch (e) {
      last = e instanceof Error ? e.message : String(e);
      continue;
    }
    const got = sizeOf(file);
    if (build.asset.size !== null && got !== build.asset.size) {
      last = `It stopped at ${got} of ${build.asset.size} bytes.`;
      // Short: carry on from here next round. Over: it isn't this file.
      if (got > build.asset.size) remove(file);
      continue;
    }
    const sum = (await hash(file)).toLowerCase();
    if (sum !== build.asset.sha256) {
      remove(file);
      // With a size to compare against, a mismatch here is corruption, not a short download: give up and say so.
      // With none, a stream that stopped early looks exactly the same, so it is worth downloading again once.
      if (build.asset.size !== null || attempt === DOWNLOAD_TRIES) return { ok: false, why: "checksum", detail: `The download doesn't match the SHA-256 GitHub reports for ${build.asset.name}. Crosstalk deleted it and installed nothing.` };
      last = "What arrived didn't match its SHA-256, and GitHub reported no size to tell a short download from a damaged one.";
      continue;
    }
    return { ok: true };
  }
  // The disk filling up is not a network problem, and it must not be told as one. What arrived goes, so a dead
  // download never sits on the room the hub keeps free for uploads and everything else.
  if (outOfSpace(last)) {
    remove(file);
    return { ok: false, why: "space", detail: "The disk filled up before the download finished, so Crosstalk deleted it and installed nothing. Free up space on this machine, then try again." };
  }
  // Otherwise what arrived stays, and the next try carries on from there with a `Range` request — unless keeping it
  // would leave the machine under the room the hub keeps free.
  const left = freeAt(dir, d);
  if (left !== null && left < diskReserve()) remove(file);
  return { ok: false, why: "download", detail: `The download didn't finish after ${DOWNLOAD_TRIES} tries${last ? ` (${last})` : ""}. Check the network and try again.` };
}

export interface SignatureCheck {
  ok: boolean;
  /** "Developer ID Application: Nikhil Venkat Sonti (8YMKWU47S5)", when the signature named one. */
  authority: string | null;
  notarised: boolean;
  detail: string;
  /** Which check failed, so the words and the result never blame the wrong one. Null when it passed. */
  why: "signature" | "notarisation" | null;
}

/**
 * A Mac app's signature and notarisation, **asked of the copy inside the mounted image, before anything is put in
 * /Applications**. `codesign --verify` says the bundle is whole and really signed; `spctl` says macOS would run it,
 * which is what notarisation decides. A build that fails either is not installed and the words say which failed.
 */
export async function checkMacSignature(app: string, d: InstallDeps = {}): Promise<SignatureCheck> {
  const run = d.run ?? runBoth;
  const verify = await run(["/usr/bin/codesign", "--verify", "--deep", "--strict", "--verbose=2", app], 120_000);
  if (!verify) return { ok: false, authority: null, notarised: false, why: "signature", detail: "codesign couldn't be run, so the signature wasn't checked. Nothing was installed." };
  if (verify.code !== 0) return { ok: false, authority: null, notarised: false, why: "signature", detail: `The downloaded app isn't properly signed (codesign said: ${oneLine(verify.err || verify.out)}). Crosstalk installed nothing.` };
  const show = await run(["/usr/bin/codesign", "-dv", "--verbose=2", app], 30_000);
  const text = `${show?.err ?? ""}\n${show?.out ?? ""}`;
  const authority = /^Authority=(.+)$/m.exec(text)?.[1]?.trim() ?? null;
  const gate = await run(["/usr/sbin/spctl", "-a", "-t", "exec", "-vv", app], 120_000);
  const gateText = oneLine(`${gate?.err ?? ""} ${gate?.out ?? ""}`);
  const accepted = !!gate && gate.code === 0 && /accepted/i.test(gateText);
  if (!accepted) return { ok: false, authority, notarised: false, why: "notarisation", detail: `macOS wouldn't open the downloaded app: it isn't notarised${gateText ? ` (${gateText})` : ""}. Crosstalk installed nothing.` };
  if (!authority || !/^Developer ID Application:/.test(authority)) return { ok: false, authority, notarised: true, why: "signature", detail: `The downloaded app isn't signed with a Developer ID${authority ? ` (it says ${authority})` : ""}. Crosstalk installed nothing.` };
  return { ok: true, authority, notarised: true, why: null, detail: `Signed by ${authority} and notarised.` };
}

export interface PlaceOptions {
  /** Where it goes ("/Applications"). */
  into: string;
  /** Replace a copy that is running. Off by default: that would throw away whatever they have open in it. */
  replaceRunning?: boolean;
}

/** The `.app` bundles `ls -1` found in a mounted image, in the order it printed them. */
const listedApps = (listed: { out: string } | null) =>
  (listed?.out ?? "")
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.toLowerCase().endsWith(".app"));

/** Why a copy that is there isn't being replaced, in the words the person (or the agent asking for them) gets. */
const openDetail = (open: RunningCheck) =>
  open.running
    ? "BrowserOS neo is open, and replacing it now would close it and lose whatever is in it. Quit it first, or say to replace it anyway."
    : "Crosstalk couldn't tell whether BrowserOS neo is open, and replacing an open copy loses whatever is in it. Quit it on this machine first, or say to replace it anyway.";

/**
 * The checked app put in place. The copy it replaces is moved aside first and only removed once the new one is there,
 * so a failure halfway leaves a working browser. **The profile is never touched**: it lives in Application Support, and
 * nothing here reads, moves or removes it, so sign-ins, tabs and history survive every update.
 */
export async function placeMacApp(from: string, name: string, opts: PlaceOptions, d: InstallDeps = {}): Promise<InstallResult> {
  const dd = defaults(d);
  const run = dd.run;
  const target = join(opts.into, name);
  const had = dd.exists(target);
  if (had && !opts.replaceRunning) {
    const open = await browserRunning(target, d);
    // Not sure counts as open: this step renames the bundle away and deletes it, so a live Chromium would lose its
    // Frameworks and Helpers mid-flight — not a clean quit, and whatever is in its tabs goes with it.
    if (open.running || !open.sure) return { done: "failed", why: "running", detail: openDetail(open) };
  }
  const staged = `${target}.crosstalk-new`;
  const aside = `${target}.crosstalk-old`;
  const rm = d.remove ?? removePath;
  rm(staged);
  rm(aside);
  // ditto keeps the bundle's signature whole; cp -R does not always.
  const copied = await run(["/usr/bin/ditto", from, staged], 10 * 60_000);
  if (!copied || copied.code !== 0) {
    rm(staged);
    return { done: "failed", why: "copy", detail: `Couldn't copy the app into ${opts.into}${copied ? `: ${oneLine(copied.err || copied.out)}` : ""}.` };
  }
  try {
    if (had) renameSync(target, aside);
    renameSync(staged, target);
  } catch (e) {
    // Put back what was there, so a failure never leaves the person without a browser.
    try {
      if (had && !dd.exists(target)) renameSync(aside, target);
    } catch {
      // Nothing more to try; the words below say where the old copy is.
    }
    rm(staged);
    return { done: "failed", why: "copy", detail: `Couldn't put the app in place (${e instanceof Error ? e.message : String(e)}). The copy that was there is at ${aside}.` };
  }
  rm(aside);
  const plist = await macPlist(join(target, "Contents", "Info.plist"), run);
  return { done: "installed", path: target, version: plist.version ?? "", replaced: had ? name : null };
}

/**
 * Download the build, check it, and install it as far as this machine lets a hub install anything.
 *
 * The order is deliberate: the SHA-256 is checked **before the image is mounted**, and the signature and notarisation
 * **before anything goes near /Applications**. A failure at any step leaves the machine exactly as it was, and the
 * words say which step failed. The person's profile is never read, moved or removed.
 */
export async function installBuild(build: Build, d: InstallDeps = {}, opts: { into?: string; replaceRunning?: boolean } = {}): Promise<InstallResult> {
  const dd = defaults(d);
  const tmp = d.tmp ?? join(tmpdir(), "crosstalk-browseros");
  const rm = d.remove ?? removePath;
  const file = join(tmp, build.asset.name);
  const got = await downloadAsset(build, file, d);
  if (!got.ok) return { done: "failed", why: got.why, detail: got.detail };
  log.info(`downloaded ${build.asset.name} (${build.version}) and its SHA-256 matched`);

  if (build.kind === "dmg") {
    if (dd.platform !== "darwin") return { done: "failed", why: "unsupported", detail: "A .dmg can only be installed on a Mac." };
    const mount = join(tmp, "mnt");
    rm(mount);
    const attached = await dd.run(["/usr/bin/hdiutil", "attach", "-nobrowse", "-readonly", "-noverify", "-mountpoint", mount, file], 5 * 60_000);
    if (!attached || attached.code !== 0) {
      rm(file);
      return { done: "failed", why: "mount", detail: `The disk image wouldn't open${attached ? `: ${oneLine(attached.err || attached.out)}` : ""}. Nothing was installed.` };
    }
    try {
      const names = listedApps(await dd.run(["/bin/ls", "-1", mount], 10_000));
      if (!names.length) return { done: "failed", why: "mount", detail: "The disk image has no app in it. Nothing was installed." };
      // Which bundle in the image is the browser is its **own bundle id**, not its file name and not the order `ls`
      // happened to print: the signature check only says some app is signed and notarised by somebody.
      const found: { name: string; bundleId: string | null }[] = [];
      for (const name of names) found.push({ name, bundleId: (await macPlist(join(mount, name, "Contents", "Info.plist"), dd.run)).bundleId });
      const app = found.find((a) => a.bundleId === BROWSEROS_BUNDLE_ID) ?? found[0];
      const signature = await checkMacSignature(join(mount, app.name), d);
      if (!signature.ok) return { done: "failed", why: signature.why ?? "signature", detail: signature.detail };
      if (app.bundleId !== BROWSEROS_BUNDLE_ID) {
        return { done: "failed", why: "identity", detail: `The app in the disk image says it is ${app.bundleId ? oneLine(app.bundleId) : "nothing in particular"}, not ${BROWSEROS_BUNDLE_ID}. Crosstalk installs only BrowserOS neo, so it installed nothing.` };
      }
      log.info(`${app.name}: ${signature.detail}`);
      // Installed under the name the rest of Crosstalk looks for (`appPaths`), never the image's own. A build that
      // renamed the bundle would otherwise install somewhere the checklist can't see, so every check would call it
      // "not installed" and download 165 MB again, leaving another copy in /Applications each time.
      return await placeMacApp(join(mount, app.name), MAC_APP_NAME, { into: opts.into ?? "/Applications", replaceRunning: opts.replaceRunning }, d);
    } finally {
      await dd.run(["/usr/bin/hdiutil", "detach", mount, "-force"], 60_000);
      rm(mount);
      rm(file);
    }
  }

  if (build.kind === "appimage") {
    // No root and no package manager: the file itself is the program, so it only has to land somewhere and be runnable.
    const into = opts.into ?? join(dd.home, "Applications");
    const target = join(into, build.asset.name);
    if (dd.exists(target) && !opts.replaceRunning) {
      const open = await browserRunning(target, d);
      if (open.running || !open.sure) return { done: "failed", why: "running", detail: openDetail(open) };
    }
    const moved = await dd.run(["/usr/bin/env", "sh", "-c", `mkdir -p "$1" && mv -f "$2" "$3" && chmod +x "$3"`, "sh", into, file, target], 60_000);
    if (!moved || moved.code !== 0) {
      rm(file);
      return { done: "failed", why: "copy", detail: `Couldn't put the AppImage in ${into}${moved ? `: ${oneLine(moved.err || moved.out)}` : ""}.` };
    }
    return { done: "installed", path: target, version: build.version, replaced: null };
  }

  // A .deb needs root and a Windows installer opens a window: the file is downloaded and checked, the last step is theirs.
  const command = build.kind === "deb" ? `sudo dpkg -i ${file}` : file;
  return { done: "ready", file, command, detail: `BrowserOS neo ${build.version} is downloaded and its SHA-256 matches what GitHub reports. ${build.kind === "deb" ? "Installing a .deb needs your password, so you run the last step." : "Run the installer on the machine to finish."}` };
}

// ---- what the setup checklist reads ----

/** Everything the `browseros` item needs, each part read without changing anything. */
export interface BrowserOsFacts {
  /** The installed copy, or null when there is none. */
  installed: Installed | null;
  /** What this machine can install; `wants` empty means nothing fits here. */
  target: BuildTarget;
  /** The newest build for this machine, or null when none was found in what GitHub gave back. */
  newest: Build | null;
  /** Why GitHub couldn't be asked, when it couldn't. `retryAt`: when a used-up allowance comes back (ms). */
  releases: { ok: true } | { ok: false; why: "offline" | "rate" | "http" | "bad"; detail: string; retryAt?: number };
  /** Its MCP endpoint on this machine, found by asking (never a guessed port). */
  mcp: McpEndpoint | null;
  /** The agents here that already have an entry for it, with the URL each one points at. */
  links: AgentLink[];
  /** The agents installed on this machine, so only those are offered a command. */
  agents: McpAgent[];
}

/**
 * Everything above, read from this machine. `agents`: which agent CLIs are installed (the hub already knows).
 *
 * GitHub and the browser's own port are asked **at the same time**, because they have nothing to do with each other:
 * one cold check is then the slower of the two (10 s) rather than their sum, which is what keeps the whole probe inside
 * the time the checklist gives it instead of timing out and reading as "couldn't check".
 */
export async function browserOsFacts(agents: McpAgent[], d: InstallDeps = {}): Promise<BrowserOsFacts> {
  const dd = defaults(d);
  const [installed, ways] = await Promise.all([readInstalled(d), linuxWays(d)]);
  const target = buildTarget(dd.platform, dd.arch, ways);
  const [releases, mcp] = await Promise.all([cachedReleases(d), installed ? discoverMcp(d) : null]);
  const newest = releases.ok ? pickBuild(releases.releases, target) : null;
  return {
    installed,
    target,
    newest,
    releases: releases.ok ? { ok: true } : { ok: false, why: releases.why, detail: releases.detail, ...(releases.retryAt ? { retryAt: releases.retryAt } : {}) },
    mcp,
    // Only the address the browser really answered on makes an unnamed entry this browser's (see `agentLinks`).
    links: agentLinks(d, mcp?.url ?? null),
    agents,
  };
}

// ---- the default, real implementations ----

export async function runBoth(args: string[], timeoutMs = 5000): Promise<{ code: number; out: string; err: string } | null> {
  try {
    const p = Bun.spawn(args, { stdin: "ignore", stdout: "pipe", stderr: "pipe" });
    const timer = setTimeout(() => p.kill("SIGKILL"), timeoutMs);
    const [out, err] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text()]);
    const code = await p.exited;
    clearTimeout(timer);
    return { code, out, err };
  } catch {
    return null;
  }
}

/**
 * The download, written straight to disk a chunk at a time — never held in memory. `append` carries on after what is
 * already there (a download that died half way), which is why this opens the file with "a" rather than reading it back.
 */
async function writeStream(path: string, body: ReadableStream<Uint8Array> | null, append: boolean): Promise<number> {
  mkdirSync(join(path, ".."), { recursive: true });
  const out = createWriteStream(path, { flags: append ? "a" : "w" });
  let written = 0;
  try {
    if (body) {
      for await (const chunk of body as unknown as AsyncIterable<Uint8Array>) {
        if (!out.write(chunk)) await once(out, "drain");
        written += chunk.byteLength;
      }
    }
  } finally {
    await new Promise<void>((done, fail) => out.end((e?: Error | null) => (e ? fail(e) : done())));
  }
  return written;
}

function fileSize(path: string): number {
  try {
    return statSync(path).size;
  } catch {
    return 0;
  }
}

async function hashFile(path: string): Promise<string> {
  const h = createHash("sha256");
  const stream = Bun.file(path).stream();
  for await (const chunk of stream as unknown as AsyncIterable<Uint8Array>) h.update(chunk);
  return h.digest("hex");
}

function removePath(path: string): void {
  try {
    rmSync(path, { recursive: true, force: true });
  } catch {
    log.warn(`couldn't remove ${path}`);
  }
}

/** One line, so a program's complaint never breaks the words around it. */
const oneLine = (s: string) => s.replace(/\s+/g, " ").trim().slice(0, 200);
