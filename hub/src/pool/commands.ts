// The one-line commands that make a computer without Crosstalk (a Windows PC, a Mac or a Linux box) one of the model
// pool's helpers (docs/MODEL-POOL.md, GET /api/pool/helper-command). Each pins the pool's llama.cpp build, downloads
// it from GitHub once into a per-user folder, finds ggml-rpc-server wherever the archive put it, reads the machine's
// own Tailscale IPv4 (refusing without one) and runs `ggml-rpc-server -H <ip> -p <port> -c` in the foreground, with
// LLAMA_CACHE next to the builds. Only checked values go into a command, inside quotes, so nothing typed elsewhere
// (a machine's name, say) can change what runs.

import type { PoolBackend } from "@crosstalk/shared";
import { HttpError } from "../engine/engine";
import { assetsFor, checkBackend, checkBuild, OLDEST_SAFE_HELPER_BUILD } from "./llama";
import { checkPort } from "./node";
import { isTailscaleIPv4 } from "../tailscale";

export type HelperOs = "windows" | "linux" | "macos";

export interface HelperCommandOptions {
  build: string;
  os: HelperOs;
  backend: PoolBackend;
  port: number;
  /**
   * The Tailscale address the pool has for the computer: the command stops with a plain message when the computer's
   * own address is another one (the wrong computer was picked). Null (or not a Tailscale address): not checked.
   */
  address: string | null;
}

export interface HelperCommand {
  command: string;
  notes: string[];
  /** What the hub serves for the short command (GET /api/pool/helper/<token>): PowerShell's block, or sh's script. */
  script: string;
}

/**
 * The weight cache (-c) has no size limit of its own and a full disk damages it without a word: with less than this
 * free, a helper command clears it, and runs without one if that isn't enough. Generous, since a computer's share of a
 * model is up to its GPU memory (32 GB on the biggest cards).
 */
export const HELPER_MIN_FREE_GB = 40;

/**
 * The command to type on a computer instead of pasting the long one: it fetches the long one from this hub's https
 * address (`url`, the hub's GET /api/pool/helper/<token>) and runs it. Windows PowerShell 5.1 needs TLS 1.2 asked for.
 */
export function shortHelperCommand(os: HelperOs, url: string): string {
  if (!/^https:\/\/[\w.-]+(:\d+)?\/api\/pool\/helper\/[a-z0-9]+$/.test(url)) throw new HttpError(500, "Crosstalk couldn't make this command: try again.");
  return os === "windows" ? `[Net.ServicePointManager]::SecurityProtocol=3072; irm ${url} | iex` : `sh -c "$(curl -fsSL ${url})"`;
}

const RELEASES = "https://github.com/ggml-org/llama.cpp/releases/download";
/** Tailscale's IPv4 range, 100.64.0.0/10, as a pattern both PowerShell and grep -E read. */
const TAILSCALE_IP_PATTERN = "^100\\.(6[4-9]|[7-9][0-9]|1[01][0-9]|12[0-7])\\.[0-9]{1,3}\\.[0-9]{1,3}$";
/** What may go into a command at all (each value is also checked for what it is). */
const SAFE = /^[\w.:-]+$/;

const OS_LIST: HelperOs[] = ["windows", "linux", "macos"];

export function checkHelperOs(os: unknown): HelperOs {
  if (typeof os !== "string" || !OS_LIST.includes(os as HelperOs)) throw new HttpError(400, "Pick the computer's system: Windows, Linux or Mac.");
  return os as HelperOs;
}

/** The computer's backend, as llama.cpp builds them for its system (a Mac's is Metal). */
export function defaultBackend(os: HelperOs): PoolBackend {
  return os === "macos" ? "metal" : "vulkan";
}

function safe(value: string): string {
  if (!SAFE.test(value)) throw new HttpError(500, "Crosstalk couldn't make this command: try again.");
  return value;
}

/** A PowerShell string literal. */
const ps = (s: string) => `'${safe(s).replace(/'/g, "''")}'`;

/** The command for a computer to run its helper, with what to know about it. */
export function helperCommand(o: HelperCommandOptions): HelperCommand {
  const build = checkBuild(o.build);
  if (Number(build.slice(1)) < OLDEST_SAFE_HELPER_BUILD) throw new HttpError(400, `llama.cpp ${build} is too old to lend a GPU safely: pick b${OLDEST_SAFE_HELPER_BUILD} or newer for the pool.`);
  const os = checkHelperOs(o.os);
  const backend = checkBackend(o.backend);
  const port = checkPort(o.port, "helper port");
  // The release files for that system (a plain refusal for ones llama.cpp doesn't build, like Metal on Windows).
  const assets = assetsFor(build, os, os === "macos" ? "arm64" : "x64", backend);
  const want = o.address && isTailscaleIPv4(o.address) ? o.address : "";
  return os === "windows" ? windows(build, backend, port, want, assets) : unix(os, build, backend, port, want, assets);
}

function windows(build: string, backend: PoolBackend, port: number, want: string, assets: string[]): HelperCommand {
  const [main, ...extra] = assets;
  const red = (text: string) => `Write-Host "${text}" -ForegroundColor Red`;
  const fetch = (asset: string, into: string) =>
    `$z=Join-Path $env:TEMP ${ps(asset)}; Write-Host "Downloading ${asset}..."; Invoke-WebRequest -UseBasicParsing -Uri "${RELEASES}/$b/${safe(asset)}" -OutFile $z -ErrorAction Stop; Expand-Archive -Path $z -DestinationPath ${into} -Force -ErrorAction Stop; Remove-Item $z -Force`;
  const findExe = `$exe=Get-ChildItem -Path $d -Recurse -File -Filter 'ggml-rpc-server.exe' | Select-Object -First 1; if(-not $exe){ $exe=Get-ChildItem -Path $d -Recurse -File -Filter 'rpc-server.exe' | Select-Object -First 1 }`;
  const install = [
    "if(Test-Path $d){ Remove-Item $d -Recurse -Force }",
    "New-Item -ItemType Directory -Force -Path $d | Out-Null",
    fetch(main, "$d"),
    findExe,
    `if(-not $exe){ throw "llama.cpp $b has no ggml-rpc-server.exe" }`,
    // CUDA's runtime libraries go next to the programs.
    ...extra.map((asset) => fetch(asset, "($exe.DirectoryName)")),
    "New-Item -ItemType File -Force -Path (Join-Path $d '.crosstalk-ok') | Out-Null",
  ].join("; ");
  const steps = [
    "$ProgressPreference='SilentlyContinue'",
    "[Net.ServicePointManager]::SecurityProtocol=[Net.ServicePointManager]::SecurityProtocol -bor 3072",
    `$b=${ps(build)}`,
    `$k=${ps(backend)}`,
    `$p=${port}`,
    `$want=${want ? ps(want) : "''"}`,
    "$root=Join-Path $env:LOCALAPPDATA 'Crosstalk\\llama'",
    `$d=Join-Path $root "$b-$k"`,
    // C:\Program Files\Tailscale\tailscale.exe (also from a 32-bit PowerShell), else tailscale on PATH.
    "$ts=@($env:ProgramW6432, $env:ProgramFiles) | Where-Object { $_ } | ForEach-Object { Join-Path $_ 'Tailscale\\tailscale.exe' } | Where-Object { Test-Path $_ } | Select-Object -First 1",
    "if(-not $ts){ $c=Get-Command tailscale -ErrorAction SilentlyContinue; if($c){ $ts=$c.Source } }",
    `if(-not $ts){ ${red("Tailscale isn't installed on this PC. Install it from tailscale.com, sign in with the same account as your other machines, then run this again.")}; return }`,
    `$ip="$(& $ts ip -4 2>$null | Select-Object -First 1)".Trim()`,
    `if($ip -notmatch '${TAILSCALE_IP_PATTERN}'){ ${red("Tailscale isn't running on this PC. Open Tailscale and sign in, then run this again.")}; return }`,
    `if($want -and $ip -ne $want){ ${red("This PC's Tailscale address is $ip, but Crosstalk has $want for it. Fix the address in Crosstalk (Model pool, Helper command), then run the new command.")}; return }`,
    `if(-not (Test-Path (Join-Path $d '.crosstalk-ok'))){ try { ${install} } catch { ${red("Couldn't install llama.cpp ($($_.Exception.Message)). Check this PC's internet connection, then run this again.")}; return } }`,
    findExe,
    `if(-not $exe){ ${red("llama.cpp is missing ggml-rpc-server.exe. Delete $d, then run this again.")}; return }`,
    // The weight cache goes when the disk is nearly full (a full disk damages it), and isn't used without room for it.
    "$cache=Join-Path $root 'cache'",
    "$min=[long]$(if($env:CROSSTALK_HELPER_MIN_FREE_GB){ $env:CROSSTALK_HELPER_MIN_FREE_GB } else { " + HELPER_MIN_FREE_GB + " })*1GB",
    "function Get-Free { try { [IO.DriveInfo]::new([IO.Path]::GetPathRoot($root)).AvailableFreeSpace } catch { [long]::MaxValue } }",
    `if((Get-Free) -lt $min -and (Test-Path $cache)){ Remove-Item $cache -Recurse -Force -ErrorAction SilentlyContinue; Write-Host "Cleared the helper's weight cache: this PC's disk is nearly full." }`,
    `$c=@('-c'); if((Get-Free) -lt $min){ $c=@(); Write-Host "Not keeping the model weights on this PC: its disk has less than ${HELPER_MIN_FREE_GB} GB free." }`,
    "$env:LLAMA_CACHE=$cache",
    `Write-Host "Lending this PC's GPU to the model pool at \${ip}:$p. Leave this window open: closing it stops the helper." -ForegroundColor Green`,
    "& ($exe.FullName) -H $ip -p $p @c",
  ];
  const command = `& { ${steps.join("; ")} }`;
  return {
    command,
    script: command,
    notes: [
      "Leave the window open while you use the pool: closing it stops the helper.",
      "If Windows asks, allow it on private networks.",
      "It only listens on this PC's Tailscale address, so only your own devices can reach it.",
      `The first time, it downloads llama.cpp ${build} from GitHub into %LOCALAPPDATA%\\Crosstalk\\llama.`,
      ...(backend === "cuda" ? ["Needs NVIDIA driver 551.61 or newer: update it from nvidia.com if the helper doesn't start."] : []),
      ...(backend === "vulkan" ? ["Uses the graphics driver's Vulkan: update the driver if the helper finds no GPU."] : []),
    ],
  };
}

function unix(os: "linux" | "macos", build: string, backend: PoolBackend, port: number, want: string, assets: string[]): HelperCommand {
  const [main, ...extra] = assets;
  const mac = os === "macos";
  const fail = (text: string) => `{ echo "${text}"; exit 1; }`;
  const steps = [
    `B=${safe(build)}`,
    `K=${safe(backend)}`,
    `P=${port}`,
    `WANT=${want ? safe(want) : '""'}`,
    `U=${RELEASES}/$B`,
    mac
      ? `[ "$(uname -s)" = Darwin ] || ${fail("This command is for a Mac: in Crosstalk, pick the system this computer runs to get its command.")}`
      : `[ "$(uname -s)" = Linux ] || ${fail("This command is for Linux: in Crosstalk, pick the system this computer runs to get its command.")}`,
    mac
      ? `[ "$(uname -m)" = arm64 ] || ${fail("The model pool needs a Mac with Apple silicon (M1 or newer).")}`
      : `[ "$(uname -m)" = x86_64 ] || ${fail("llama.cpp has ready-made Linux builds for x64 PCs only.")}`,
    mac ? `R="$HOME/Library/Application Support/Crosstalk/llama"` : `R="\${XDG_DATA_HOME:-$HOME/.local/share}/crosstalk/llama"`,
    `D="$R/$B-$K"`,
    `TS="$(command -v tailscale || true)"`,
    ...(mac ? [`[ -n "$TS" ] || { [ -x /Applications/Tailscale.app/Contents/MacOS/Tailscale ] && TS=/Applications/Tailscale.app/Contents/MacOS/Tailscale; }`] : []),
    `[ -n "$TS" ] || ${fail("Tailscale is not installed here. Install it from tailscale.com, sign in with the same account as your other machines, then run this again.")}`,
    `IP="$("$TS" ip -4 2>/dev/null | head -n 1)"`,
    `echo "$IP" | grep -Eq "${TAILSCALE_IP_PATTERN.replace(/\$$/, "\\$")}" || ${fail("Tailscale is not running here. Open Tailscale and sign in, then run this again.")}`,
    `[ -z "$WANT" ] || [ "$IP" = "$WANT" ] || ${fail("This computer has the Tailscale address $IP, but Crosstalk has $WANT for it. Fix the address in Crosstalk (Model pool, Helper command), then run the new command.")}`,
    `get() { if command -v curl >/dev/null 2>&1; then curl -fL --retry 3 -o "$1" "$2"; else wget -O "$1" "$2"; fi; }`,
    `find_bin() { BIN="$(find "$D" -type f -name ggml-rpc-server | head -n 1)"; [ -n "$BIN" ] || BIN="$(find "$D" -type f -name rpc-server | head -n 1)"; }`,
    [
      `if [ -f "$D/.crosstalk-ok" ]; then :; else`,
      `T="$(mktemp -d)" || exit 1;`,
      `rm -rf "$D"; mkdir -p "$D" || exit 1;`,
      `echo "Downloading llama.cpp $B into $D...";`,
      `get "$T/a.tar.gz" "$U/${safe(main)}" || { echo "Could not download llama.cpp. Check the internet connection, then run this again."; rm -rf "$T"; exit 1; };`,
      `tar -xzf "$T/a.tar.gz" -C "$D" || { echo "Could not unpack llama.cpp. Run this again."; rm -rf "$T"; exit 1; };`,
      // CUDA's runtime libraries go next to the programs.
      ...extra.map((asset) =>
        [
          `find_bin; [ -n "$BIN" ] || { echo "llama.cpp is missing ggml-rpc-server. Run this again."; rm -rf "$T"; exit 1; };`,
          `mkdir -p "$T/x" && get "$T/x.tar.gz" "$U/${safe(asset)}" && tar -xzf "$T/x.tar.gz" -C "$T/x" || { echo "Could not download the CUDA runtime. Check the internet connection, then run this again."; rm -rf "$T"; exit 1; };`,
          `find "$T/x" \\( -type f -o -type l \\) -exec mv -f {} "$(dirname "$BIN")/" \\; ;`,
        ].join(" "),
      ),
      `rm -rf "$T"; touch "$D/.crosstalk-ok";`,
      `fi`,
    ].join(" "),
    "find_bin",
    `[ -n "$BIN" ] || ${fail("llama.cpp is missing ggml-rpc-server. Delete $D, then run this again.")}`,
    `chmod +x "$BIN"`,
    // The weight cache goes when the disk is nearly full (a full disk damages it), and isn't used without room for it.
    `C="$R/cache"`,
    `M=$(( \${CROSSTALK_HELPER_MIN_FREE_GB:-${HELPER_MIN_FREE_GB}} * 1048576 ))`,
    `free_kb() { F="$(df -Pk "$D" 2>/dev/null | tail -n 1 | tr -s " " | cut -d " " -f 4)"; case "$F" in ""|*[!0-9]*) F=999999999999;; esac; }`,
    `free_kb; if [ "$F" -lt "$M" ] && [ -d "$C" ]; then rm -rf "$C"; echo "Cleared the weight cache of the helper: the disk is nearly full."; free_kb; fi`,
    `CACHE=-c; if [ "$F" -lt "$M" ]; then CACHE=""; echo "Not keeping the model weights here: the disk has less than ${HELPER_MIN_FREE_GB} GB free."; fi`,
    `export LLAMA_CACHE="$C"`,
    ...(mac ? [] : [`export LD_LIBRARY_PATH="$(dirname "$BIN")\${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH}"`]),
    `echo "Lending the GPU of this computer to the model pool at $IP:$P. Leave this window open: closing it stops the helper."`,
    `exec "$BIN" -H "$IP" -p "$P" $CACHE`,
  ];
  const script = steps.join("; ");
  // The script goes to sh in single quotes: it never has one of its own.
  if (script.includes("'")) throw new HttpError(500, "Crosstalk couldn't make this command: try again.");
  const where = mac ? "~/Library/Application Support/Crosstalk/llama" : "~/.local/share/crosstalk/llama";
  return {
    command: `sh -c '${script}'`,
    script,
    notes: [
      `Leave the ${mac ? "Terminal window" : "terminal"} open while you use the pool: closing it stops the helper.`,
      `It only listens on this ${mac ? "Mac" : "computer"}'s Tailscale address, so only your own devices can reach it.`,
      `The first time, it downloads llama.cpp ${build} from GitHub into ${where}.`,
      ...(backend === "cuda" ? ["Needs a recent NVIDIA driver: update it if the helper doesn't start."] : []),
      ...(backend === "vulkan" ? ["Needs the GPU's Vulkan driver (Mesa 25.1 or newer for Radeon RX 9000 cards)."] : []),
      ...(os === "linux" ? ["Easier: set the Linux machine up as a Crosstalk hub (Settings → Machines), and Crosstalk starts its helper itself."] : []),
    ],
  };
}
