# Developing Crosstalk

## How it fits together

```
 phone / laptop / desktop                     the hub computer (always on)
 ┌───────────────────────┐  HTTPS + WebSocket  ┌──────────────────────────────────────────┐
 │ Crosstalk web app     │◄──── (Tailscale) ──►│ crosstalk-hub (one binary)                │
 │ (PWA or native shell) │                     │  chats · turn engine · SQLite             │
 └───────────────────────┘                     │  Claude Code   claude -p (stream-json)    │
                                               │  Codex         codex app-server (JSON-RPC)│
                                               │  others        ACP / SDK drivers          │
                                               └──────────────────────────────────────────┘
```

- The hub is a single Bun-compiled binary with the web app embedded. It listens on `127.0.0.1:7420`; `tailscale serve`
  publishes it on the tailnet over HTTPS. Data lives in `~/.crosstalk` (SQLite, uploads, settings).
- Each agent is the vendor's own CLI, signed in with its own official sign-in. The hub drives it, streams its work to
  every device, and keeps the agent's own session, so a rewind rewinds the agent's context too.
- One app can be paired with several hubs (machines); each keeps its own chats.

## Layout

| Folder | What's there |
|---|---|
| `shared/` | Protocol types shared by the hub and the app |
| `hub/` | Server, turn engine, agent drivers, terminals, Web Push, installers' embedded copies |
| `web/` | The React app (also served by the hub) |
| `native/` | Tauri shells for macOS, Windows, Linux, iOS and Android; `native/hub-tray` is the hub's menu-bar/tray app |
| `deploy/` | Platform installers (`install-macos.sh`, `install.sh` for Linux) |
| `editor/` | The optional image editor's phone page (a ComfyUI custom node) |

## Run it from source

Needs [Bun](https://bun.sh) 1.4+.

```bash
bun install
CROSSTALK_HOME=.crosstalk-dev bun hub/src/main.ts serve     # hub on :7420 (serves web/dist), prints a pairing code
bun run dev:web                                             # Vite on :5180 with /api proxied to the hub
```

Add a **Test agent** (provider `mock`) to try chats, approvals, rewinds and stops without using any plan.

## Tests

```bash
bun run typecheck
bun run test            # hub unit tests + web unit tests
bun run e2e             # the compiled hub binary end to end, through its public API
bun run test:browser    # Playwright: Chromium + WebKit, phone to desktop widths
```

## Build

```bash
bun hub/scripts/build.ts                  # every platform: darwin-arm64, darwin-x64, linux-x64, linux-arm64
bun hub/scripts/build.ts linux-x64        # one
```

Outputs `hub/out/crosstalk-hub-<os>-<arch>`. On macOS, sign it before installing: macOS remembers what the hub may open
by its signature (`install-macos.sh` signs with your Apple Development identity if you have one, otherwise ad hoc).

Releases: push a tag `vX.Y.Z` and `.github/workflows/release.yml` builds every platform and publishes the GitHub
Release that `install.sh` and `install.ps1` download from (with `SHA256SUMS`).

## Native apps

```bash
cd native
./scripts/package-macos.sh                                  # macOS .app + .dmg
./node_modules/.bin/tauri ios build                         # iOS (simulator: --target aarch64-sim --debug)
./node_modules/.bin/tauri android build --apk               # Android (needs ANDROID_HOME, NDK_HOME, JDK 21)
./node_modules/.bin/tauri build --runner cargo-xwin --target x86_64-pc-windows-msvc   # Windows, from macOS
```

- Build the Linux desktop app on Linux (needs `libwebkit2gtk-4.1-dev`).
- Use the workspace CLI (`./node_modules/.bin/tauri`); `bunx tauri` resolves to an unrelated package.
- macOS builds are ad-hoc signed; Windows builds are unsigned. Background push for the native iOS/Android apps isn't
  implemented: use the installed web app for notifications.

The hub menu-bar/tray app: `native/hub-tray/scripts/build-macos.sh` (see [HUB-APP.md](HUB-APP.md)).

## Status of each agent

- **Claude Code** and **Codex**: verified end to end (sign-in, plan usage, turns, approvals, rewinds, helpers).
- **Gemini CLI, Antigravity CLI, Muse Code**: drivers tested against faithful fakes of their protocols; join them to a
  group chat. Not yet confirmed against real signed-in runs.
- **OpenCode** and Crosstalk's own built-in agent: run on an AI service's API key; tested against stand-in services.
- **Windows hubs** run the Linux hub inside WSL2 (`install.ps1`).
