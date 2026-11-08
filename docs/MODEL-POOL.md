# Model pool

One local model split across several machines with llama.cpp's RPC backend, offered to chats as a custom model.
Settings → Model pool. The facts below are for llama.cpp b11669.

## How it works

- **Main machine**: holds the GGUF file and runs `llama-server --rpc helperA:port,helperB:port …`. It must be a
  Crosstalk hub (this one, or a linked hub from Settings → Machines), because Crosstalk downloads the model there and
  runs the server. It answers chats over the Anthropic Messages API (`/v1/messages`, Claude Code) and the Responses API
  (`/v1/responses`, Codex, marked partial upstream).
- **Helpers**: lend their GPU by running `ggml-rpc-server -H <Tailscale IPv4> -p <port> -c` (on a hub, `-d` names its
  GPUs, and `-c` is used only with room on the disk). A helper is a Crosstalk hub (Crosstalk starts it there) or any
  other computer, e.g. a Windows PC, where the user runs a command Crosstalk shows (PowerShell or sh; a short one to
  type when the hub has an https address, which fetches the long one from the hub). That command downloads the pinned
  llama.cpp build from GitHub and keeps the helper running in its window.
- The main machine's own GPU takes part too unless it's left out (`-dev` lists the devices used). RPC devices are named
  `RPC0, RPC1, …` across the helpers in `--rpc` order, **one per device each helper serves** (a helper with two GPUs is
  RPC0 and RPC1, the next helper RPC2; each line's description is the helper's `ip:port`), so the main machine lists
  them with `--rpc … --list-devices` before it starts. A Mac hub is best left out: its GPU is often the slowest (a base Apple
  silicon Mac can take around three times as long per GB of weights per token as a mid-range desktop GPU), it runs the hub and agents,
  and Metal memory is wired (can't be swapped).
- When the main machine's server is healthy, the controller hub adds (or updates) a custom-model account named
  "Model pool" for Claude Code and for Codex pointing at it (`http://<main Tailscale IP>:<port>`, or 127.0.0.1 when the
  main machine is this hub), with an API key Crosstalk generated, the model alias, and the context size the server
  reports in `/props`. Chats on that account are restarted with the new settings, as for any custom model change, and a
  chat still naming the model of an earlier run is moved to the new alias with a note (the pool serves one model at a
  time).

## Chatting with it

The pool is offered as one model to chat with, not as its two accounts: `Pool.chatOffer()` makes a `PoolOffer` (its
name, state, detail, model, machines, machines that didn't answer, and its accounts), which goes with the state snapshot
and again as a `poolOffer` event whenever it changes. New chat, Home, the agent screens and the chat list's heading show
one entry from it, say which state it's in, and do what that state calls for — start the chat, offer to start the pool
(saying first what starting installs, downloads and holds: nothing runs on anyone's machine without that tap), check the
machines again when one of them didn't answer the last time Crosstalk looked (a stale check mustn't stand in the way of
a start that would work), or go to Settings → Model pool to set the pool up. The agent that drives it is one that is
installed here, as a service's is. A chat on the pool is the pool and its model everywhere it names itself, with the
driving agent in its settings and its model menu; while the pool isn't running, a reply is refused in plain words with
the ways out that exist (start the pool again, or move the chat to another account in its settings — its model menu
holds the pool's one model) instead of the agent failing on a refused connection. The words and the decisions are in
`web/src/poolChat.ts`.

## Facts that shape the code (llama.cpp b11669 = v0.7.0, 2026-10-15)

- **One identical build on every machine.** The RPC handshake checks the major protocol version (v8 now), but even
  matching majors crash on the first graph if op ids differ. The pool pins one build (`PoolConfig.build`, default
  `b11669`); hubs install exactly that, the helper command names it.
- Release assets: `https://github.com/ggml-org/llama.cpp/releases/download/<build>/<asset>`, with a sha256 `digest` per
  asset in `GET https://api.github.com/repos/ggml-org/llama.cpp/releases/tags/<build>`.
  - macOS arm64: `llama-<build>-bin-macos-arm64.tar.gz` (extracts to `llama-<build>/` with the binaries at its top).
  - Linux x64: `llama-<build>-bin-ubuntu-vulkan-x64.tar.gz` (AMD, Intel and NVIDIA through Vulkan; Mesa ≥ 25.1 for
    RDNA 4 matrix cores), `…-ubuntu-x64.tar.gz` (CPU), `…-ubuntu-cuda-12.8-x64.tar.gz` + `cudart-llama-<build>-bin-ubuntu-cuda-12.8-x64.tar.gz`.
  - Windows x64: `llama-<build>-bin-win-vulkan-x64.zip`, or for NVIDIA `llama-<build>-bin-win-cuda-12.4-x64.zip` plus
    `cudart-llama-bin-win-cuda-12.4-x64.zip` unpacked into the same folder (CUDA 12.4 needs driver ≥ 551.61; the 13.4
    build needs R615+). On an older NVIDIA desktop GPU, CUDA is usually faster at prompts than Vulkan.
  - The RPC server binary is `ggml-rpc-server` (`.exe` on Windows); before June 2026 it was `rpc-server`. RPC is a
    backend library loaded at runtime, so keep `libggml-rpc.*` / `ggml-rpc.dll` next to the binaries.
- `ggml-rpc-server` flags: `-H` (numeric IPv4 only, default 127.0.0.1), `-p` (default 50052), `-c` (cache weights in
  `$LLAMA_CACHE/rpc`, one file per tensor, no size limit: prune it; a full disk corrupts it silently), `-d` devices
  (default: every GPU, else the CPU, whose memory is the system RAM), `-t` threads. **It serves one client at a time and has no auth, TLS or timeouts.** Any TCP connection held open
  blocks it, so never probe a helper while the pool's server uses it, and only bind it to the machine's Tailscale
  address (never 0.0.0.0). Builds before b11000 have unauthenticated RCE bugs.
- `llama-server`: default port 9931; `--rpc` must come **before** `--list-devices` and `-dev`; `--list-devices` prints
  `  <name>: <description> (<total> MiB, <free> MiB free)` lines (`  (none)` when empty); `--api-key`; `-a/--alias` is
  the model id clients see; `-c` context; `--jinja` is on by default (tool calls need it); `--cache-ram 0` (saving the
  prompt cache aborts the server under RPC); `--load-mode none` on a Mac main machine (Metal keeps a mmapped model
  resident); `--no-mmap` no longer exists. `/health` stays public.
  - `-np 1`: by default (`-np -1`, auto) it runs 4 slots sharing one KV cache of `-c` tokens, `/props` still reports
    the slot's context, and overlapping requests that together need more than `-c` all fail with HTTP 500 "Context
    size has been exceeded" (checked: three ~120-token requests at `-c 256`). One slot queues them instead.
  - `-ngl all`: with `-c` set, `--fit` (on by default) never cuts the context ("set by user → no change"); it moves
    layers to the main machine's CPU instead (`-ngl` defaults to auto: "offloaded 0/7 layers to GPU", still healthy,
    very slow). With `-ngl all` fit stops ("n_gpu_layers already set by user … abort"), so a model that doesn't fit
    fails with "out of memory" and the status says to pick a smaller quant or context.
  - `/props` `default_generation_settings.n_ctx` is the slot's context, capped at the model's training context
    (`n_ctx_train`): the real value chats get.
  - A helper another client holds never answers `--list-devices` (the TCP handshake still completes), so the main
    machine asks each helper on its own with a 20-second limit before the server starts.
- By default weights and KV cache are split in proportion to each device's **free** memory, not its speed; the Mac
  reports Metal's working set (on a Mac with 16 GB, for example, roughly three quarters of it) and ignores other apps.
- Speed: per token only a few kB cross each boundary, so generation is bound by round trips (Tailscale relays add tens
  of ms each); prompts and first loads are bound by bandwidth (`-c` makes reloads local). Pooling buys room, not speed:
  a model that fits one machine should run there alone.

## Security

- Helpers bind to the Tailscale IPv4 only; Crosstalk refuses to start one without it. Tailscale encrypts and
  authenticates; the UI says to keep the tailnet to the user's own devices.
- The main machine's server binds to 127.0.0.1 when only this hub uses it, else to its Tailscale IPv4, always with an
  API key (kept in the hub's secrets file).
- A Hugging Face token (for gated models such as orcarouter/Qwen3.8-27B-GGUF) is entered by the user,
  kept in the controller hub's secrets (`HF_TOKEN`), and passed to the main machine only for a download.

## Not possible here (2026-10-25)

- Kimi K3.1 Pro: ~2.8T parameters (104B active); weights due by 2026-11-04; the smallest GGUF of the same-architecture
  Kimi K3 is 594 GB (needs ≈610 GB of RAM+VRAM). Offered instead as a preset for Moonshot's API in Add a custom model:
  Claude Code `https://api.moonshot.ai/anthropic`, Codex `https://api.moonshot.ai` (`/v1/responses`), models
  `kimi-k3.1-pro` and `kimi-k3.1-pro-highspeed`, 1,048,576 tokens of context, paid per use.

## API (hub routes; types in shared/src/protocol.ts)

Controller routes, on the hub where the pool is set up (a person's device or a full-scope hub sign-in; never peer):

| Route | Body / query | Returns |
|---|---|---|
| `GET /api/pool` | | `PoolView` |
| `PUT /api/pool` | `{ config: Partial<PoolConfig> }` (machines replaced as a whole when given) | `PoolView` |
| `POST /api/pool/check` | | `PoolView` after asking every machine (devices, Tailscale round trip, helper reachable) |
| `POST /api/pool/start` · `POST /api/pool/stop` | | `PoolView` (progress follows as `pool` events) |
| `GET /api/pool/models?repo=<repo or Hugging Face URL>` | | `PoolModelChoices` (GGUF files grouped into models, mmproj files left out, smallest first) |
| `PUT /api/pool/hf-token` | `{ token: string \| null }` | `{ hasHfToken: boolean }` |
| `GET /api/pool/helper-command?machine=<id>&os=windows\|linux\|macos&backend=vulkan\|cuda\|metal\|cpu` | | `{ command: string; notes: string[]; script: string; short?: string }` (`short`: a command to type that fetches the long one from the hub, when the hub has an https address) |
| `GET /api/pool/helper/<token>` | no sign-in (the token, from `short`, is the permission) | the computer's helper script as text (PowerShell or sh), as it is now |
| `GET /api/pool/tailscale` | | `{ peers: { name: string; address: string; os: string; online: boolean; direct: boolean \| null }[] }` from this hub's `tailscale status --json` |
| `POST /api/pool/model/remove` | `{ files: string[] }` | `PoolView` (files moved to the Trash on the main machine; `PoolView.mainFiles` lists them) |

Node routes, on every hub, called by the controller (with the full-scope token of its link) or by itself:

| Route | Body | Does |
|---|---|---|
| `GET /api/pool/node` | optional `?refresh=1` (ask llama.cpp for the GPUs again), `?build=…&backend=…` (whose GPUs) | `PoolNodeInfo` |
| `POST /api/pool/node/install` | `{ build, backend }` | installs that llama.cpp build (in the background; `busy` shows it) |
| `POST /api/pool/node/helper` | `{ action: "start" \| "stop", build, backend, port, owner?, cacheBytes? }` | runs or ends `ggml-rpc-server -d <its GPUs> [-c]` on its Tailscale IPv4 |
| `POST /api/pool/node/model` | `{ action: "download" \| "cancel", model: PoolModel, hfToken?: string }`, or `{ action: "remove", files: string[] }` (as `PoolNodeInfo.models` lists them) | downloads the model (resumable) to `~/.crosstalk/models/`; `remove` moves files to the Trash |
| `POST /api/pool/node/server` | `{ action: "start" \| "stop", build, backend, model, rpc: string[], devices: string[] \| null \| "helpers", contextSize, alias, port, host, apiKey, owner? }` | asks each helper, then runs (or ends) `llama-server` |

Every node route answers with the hub's `PoolNodeInfo` (a `stop` body needs only the action). Peer sign-ins get 403.
`owner` (`PoolOwner`: the controller's hub id and name, and a run id per start) says whose pool it is: a start from
another hub's pool is refused (409 `in_use`) while the owner still asks about what it runs (`GET /api/pool/node?owner=
<hub id>` or any request carrying it); what runs for another hub ends by itself 10 minutes after its owner stopped
asking (a crash, a power cut, an unlink); a `stop` with an `owner` leaves another hub's alone; a new run of the same
pool gets a fresh helper (no client from before). `PoolNodeInfo.helper/server.owner` and `PoolNodeInfo.files` (model
files with sizes, unfinished ones too) are optional additions. The helper serves exactly the GPUs llama.cpp lists there
(`-d`), and refuses (409 `no_gpu`) where it finds none. `cacheBytes` is about how much of the model the helper gets:
`-c` only with room for that plus the hub's reserve and 10 GB, the oldest cache files going first (and the cache kept
within a quarter of the disk); a disk that fills up while it runs has the cache cleared before the next start. A server
start first lists each helper's devices from the main machine (20 s each): 409 `helper_busy` (another program holds it)
or `helper_unreachable` names its address; `devices: "helpers"` then means every RPC device they serve.
A background install, download or GPU check that fails is reported in `PoolNodeInfo.lastError` (plain words, with
what to do). `devices: []` runs on no GPU (`-dev none`); `null` leaves `-dev` out. The API key reaches llama-server as
`LLAMA_API_KEY` (never on its command line). Hooks for tests: `CROSSTALK_GITHUB_API`, `CROSSTALK_LLAMA_RELEASES`,
`CROSSTALK_HF_URL`, `CROSSTALK_TAILSCALE_BIN`, and `CROSSTALK_POOL_LOOPBACK=1` (a helper may listen on 127.0.0.1).

Events: `{ t: "pool", pool: PoolView }` on the controller hub whenever the view changes (download progress at most
twice a second), and `{ t: "poolOffer", offer: PoolOffer }` with it when what the pool is as a model to chat with
changed (`StateSnapshot.pool` carries the same thing to a device that has just connected).

Controller notes (hub/src/pool/pool.ts, commands.ts, tailscale.ts): settings live in kv `pool`; this hub and every
linked hub are always in the machine list (a hub this hub only has an agents' sign-in on is listed switched off, with
why). `PUT /api/pool` answers 400 with plain words for any bad field and saves nothing then; an empty `alias` follows
the model. `POST /api/pool/start` answers at once (`preparing`); a problem becomes `status.state: "error"` with a
`detail` saying what to do, and what that start ran is ended. `POST /api/pool/stop` answers once it's stopped.
`POST /api/pool/model/remove` takes the model's files as its repo lists them (`PoolModel.files`) or as the main
machine lists them (`owner/repo/file`, as `PoolView.mainFiles` shows them with their sizes), and answers 409 for the
model the pool uses while it runs (others can go). Downloads are pinned to the repo's commit when they begin (`resolve/<sha>/…`, the sha kept in
`<first file>.rev` until every part is done), so a resumed `.part` is never joined to a file uploaded again; a commit
that's gone starts a download with nothing finished again from the newest one. The helper command notes the build it
names, and a start refuses (with what to do) when the pool's build changed since. The fit: model + `contextSize` ×
96 KiB + 1 GiB per machine taking part, against the free memory of those machines' GPUs as last checked (a computer's
can't be seen from here, so it isn't counted). With `CROSSTALK_POOL_LOOPBACK=1` (tests) every helper and server is on
127.0.0.1, so a whole pool runs on one machine.

Runs and their leftovers: the steps are install → check the computers → download → start the hubs' helpers → start
the server (helpers don't sit idle through a download). A running pool watches its main machine's server, each hub's
helper (its node info) and, every 30 s, each computer over `tailscale ping`; whatever stops gets the one automatic
restart (a hub's stopped helper is started again). Starting again from a problem first ends what the last start still
ran. What a start runs on other hubs is noted in kv `pool.left` until it's ended, so a hub that stopped without ending
it (a crash) ends it when it starts again (`recover()` in main.ts, before `resume()`), and a check ends what no current
start of this pool owns. Unlinking a hub the pool uses stops the pool first ("Stopped: X was unlinked."). Each hub's last
Tailscale address is kept in kv `pool.addresses`. "Start when the hub starts" keeps "it was running" when its start
fails, and tries again (10 s, then doubling to a minute) for 15 minutes while a machine or Tailscale isn't up yet. A new
pool starts at 64k of context (Claude Code needs about 20k to start; chats summarize at three quarters). A linked hub
where llama.cpp found no GPU is switched off by default. A computer's helper command clears its weight cache when the
disk has less than 40 GB free, and runs without one then.

## A PC's GPU memory

Crosstalk can't ask a PC anything (it only runs the helper command). While the pool is off, a check asks the main
machine's llama.cpp to list each answering PC helper's GPUs (`llama-server --rpc <pc>:<port> --list-devices`, GET
`/api/pool/node/helpers`), so the fit counts them. llama.cpp names a helper's GPUs by its address, so they're shown as
"GPU of <PC name>". This needs the pool's build on the main machine (installed the first time the pool starts).
