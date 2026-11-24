# Changelog

## 0.9.0

**Getting started**
- **The installer is four plain lines and a QR code.** A first install ends with the pairing code and its QR code for
  your phone, and opens Crosstalk in the computer's own browser when you're sitting at it. An update just says what it
  went from and to. Without Tailscale it still installs and says the one thing left to do.
- **Set up an agent in one tap.** The welcome card installs Claude Code or Codex right there if the computer doesn't
  have it, and its sign-in opens the moment it's in.
- **Gemini CLI can be set up from the phone on a new machine.** A Gemini CLI that had never run asked two questions
  nobody could answer; Crosstalk answers them and goes straight to Google's sign-in.
- **No Node.js needed.** Gemini CLI and OpenCode install on a machine without it (Crosstalk gets one for its own use).
- **Pair a phone from the computer.** The welcome card offers it when Crosstalk is open on the machine itself, and
  the pairing dialog says what's missing when a phone couldn't reach the machine yet.
- On an Apple silicon Mac the installer also adds **Crosstalk Hub**, a small menu-bar app: Crosstalk's status, Pair a
  phone and its log, without a terminal.

**Chat settings**
- **One sheet for everything about a chat.** The sliders button in a chat opens Chat settings, with five plain
  sections: Answers with (account, model, effort and the model's extras), May do (permissions, each said in one
  sentence), Helpers, Memory (how much the model remembers, Summarize now, Start fresh) and This chat (name, folder,
  pin, duplicate, export, delete). A group chat has the group's own section first, then one block per agent.
- **The row under the message box is two chips and a ring**, saying what's in force in words ("Opus 5.5 · High",
  "Asks first"). Tap a chip, tap a choice: switching model or permissions is still two taps.
- **The same choices look the same everywhere**: New chat's More options and Settings → New chats use the sheet's
  own building blocks, and the sheet offers "Use these for new chats too".
- Each choice says when it takes effect (at the next reply, after helpers finish, or with a fresh start).
- A chat's header names the model as the chips do ("Opus 5.5", not its id).
- Fixed: while a chat waited for your approval, the small status dot on its picture swelled into an orange blob.
- Fixed: in Safari, pressing Tab in an open sheet or dialog could move the focus to the page behind it.

**Agents working together**
- **Helpers on another account.** A chat's agent can hand helper work to an account you choose instead of spending the
  chat's own: the same agent on an API key (Claude Code's helpers on a Claude API key rather than your plan), another
  agent (Codex helping Claude Code), another service, or one of your own models. "Helpers run on" is in Chat
  settings → Helpers, in New chat's More options, and in Settings → Agents together as the default for new chats. Each helper
  shows in the chat while it works, asks through the chat for anything above the chat's permissions, stops with Stop,
  and its cost goes on its own account (and respects that account's spending limit). For Claude Code and Codex chats.
- **Quick questions** (was Teamwork): agents can ask another agent one read-only question, and you choose who they
  can ask. Their cost is recorded and counts towards spending limits now.
- **Group chats are easier to start.** "Add an agent" lists every account that can answer in one tap, and there is
  one choice for how they work together: one leads and the others help when asked, everyone answers in turn, or one
  builds and another reviews. The finer points are under More.

**Themes**
- **Settings → This device → Theme.** Thirteen looks to pick from: OLED black (as before, still the default), Charcoal,
  Midnight, Ember and Terminal; three light ones (Light, Paper, and Sunlight for outdoors); and colourful ones with
  see-through panels: Aurora, Sunset, Ocean, Dawn and **Liquid glass**.
- **Your own:** a background colour, a gradient (its colours, angle, shape) or a picture of yours with blur and dimming;
  an accent colour; how see-through and how rounded panels are. Words stay readable whatever you choose, and a theme is
  this device's own.

**Foldables, phones and computers**
- **Unfolding a foldable no longer cuts the screen in half.** The two-part layout for a half-folded phone is now that
  device's own choice (Settings → This device, shown on phones that fold) and off until you turn it on.
- **Phones:** a long reply's actions stay within reach; a group chat keeps its full message box while agents work, with
  each agent's Stop on its own line; back from the background, a chat says it's catching up instead of showing stale
  work; small fixes at 320 px.
- **Computers:** drag the chat list's edge to resize it; Ctrl/Cmd+K jumps to a chat and Alt+N starts one; drop files
  anywhere on a chat; Esc closes what's open; a chat is ready to type in when it opens; sheets are centred dialogs.

**Removed**
- **Model pool** (one model split across several machines). Models on a single machine (Settings → Your own models)
  work as before. A machine that had a pool keeps its accounts and data.

**Linux and Windows**
- Every change is now checked on Linux: the tests, the built program, a real install as a background service (start,
  stop, update, remove) and each agent's own installer.
- Fixed on Linux: the restart-when-quiet scripts say when `sqlite3` is missing instead of failing silently, setting up
  another Linux machine needs no python, cleaning up storage knows where Linux keeps pip's and Homebrew's downloads
  and the Trash, the terminal opens the person's own shell, and setup no longer speaks of a Mac's folders there.
- The Linux installer needs no python, waits for Crosstalk to answer before saying it runs, and tells an Ubuntu
  inside Windows how to turn systemd on. The Windows installer follows what it prints now.
- Hints for a missing tool name the package manager the machine has (apt, dnf, pacman, zypper or apk).

## 0.8.1

- **Screen shows the Mac's real desktop.** It signs in to Screen Sharing as the Mac's own account, with the account
  filled in: you type the password you log in to the Mac with. (macOS gives a sign-in by the separate screen sharing
  password a login screen of its own, not the desktop.) If that's what you're looking at, Screen says so and takes the
  account's password right there. A full name typed as the account works too.
- **Screen behaves like a remote desktop with a mouse**: it opens in Control, the keyboard is the machine's at once and
  stays so after you use a button of the page, the whole screen fits the window and follows its size, and there's a
  full screen button. Watching, a click or a key says how to take control.

## 0.8.0

Fewer things to learn, and the same word for the same thing everywhere.

- **One rule for a message sent while the agent works.** It goes into the running reply by itself, and the agent reads
  it at its next step. One button, **Interrupt**, stops the reply and answers your message now. Send now, Answer now
  and Read it now are gone.
- **The chat list is ordered by what needs you**: Pinned, Needs you, Working, Recent. Each row says its state in words
  ("Needs your OK", "Working · 12m", "2 helpers working", "Back at 5:00 AM") instead of a coloured dot, and shows whose
  chat it is by the agent's logo. Screen, Bookmarks, Terminal and Settings are one row under the list.
- **Settings is one list of pages** with a search field: Accounts, New chats, Agents together, Usage & costs, This
  device, Machines, Your own models. What needs you is at the top, each with a button that does it there. The plan
  meters are on Usage & costs itself, and a dozen switches nobody needed are gone.
- **One Accounts list.** Every account once (a plan you sign in to, an API key, another service, a model of your own),
  each with its state and its own actions, and one "Add an account".
- **New chat asks one thing: the folder.** The name, a template, the account, model, effort and permissions are under
  More options, whose closed row says what the chat starts with. It stays open on a device where you open it.
- **Stop helpers.** Helpers still working after their agent's reply has ended can be stopped from the chat, in two taps.
- **Codex installs without Node.js**, from OpenAI's own build.
- **Pair by scanning.** The installer and `crosstalk-hub pair` show a QR code under the pairing code: point the
  phone's camera at it and Crosstalk opens with the code filled in. On an iPhone the pairing screen says to add
  Crosstalk to the Home Screen first, since the icon is what gets notifications.
- **One word per thing**: machine, device, chat, account, helper, reply, folder, across the app, its messages and
  these docs.
- Back from a page of Settings is the list of pages, then the screen you came from.
- On a phone, the + and the mic and the row of chat settings under the message box take a tap 44 px tall.
- The app loads about four times lighter over a phone's connection (its files go out compressed).
- The log says the day and the local time, and why a reply failed.

## 0.7.1

- **Updates apply themselves.** A new version starts once the chats have been quiet for two minutes; Home says
  "Update ready" meanwhile, with Restart now. It never restarts over running work by itself.
- **The memory guard steps in.** When the machine runs low on memory it now says what is using it and in which chat,
  ends idle agents, asks the agent to close its browser pages, and if it keeps getting worse stops that reply and
  closes the agents' browser pages before the machine freezes. After a freeze it doesn't re-run the reply that caused
  it. Settings → Memory → "Free memory by itself" (on).
- **Back works like an app's.** The phone's Back goes to the screen you came from, and closes the chat list or a
  dialog first, instead of leaving Crosstalk.
- **A first chat always starts on an account that can answer**, and offers Sign in where it can't.

## 0.7.0

- **Screen**: see the machine's screen live in the app, with buttons that take the view to each window (an agent's
  first), and take control to click and type on it from your phone. Agents can use the screen too, once you let them:
  for apps with no command line and for dialogs waiting on the screen. It works through the machine's own screen
  sharing, turned on once ([docs/SCREEN.md](docs/SCREEN.md)).
- A working chat has a button that goes straight to the screen.

## 0.6.11

- Claude models always show their version ("Opus 5.5", not "Opus"), even when Claude Code names one by its family only.

## 0.6.10

- Unsend that Claude Code can't do (it has summarized the conversation since that message) says why, and its notice offers **Start fresh and unsend** in one tap. After starting fresh, unsending works.

## 0.6.9

- Each agent shows its own logo (Claude Code, Codex, Muse Code, Antigravity, Gemini CLI, OpenCode) instead of two letters.

## 0.6.8

First public release.

- **One-line install** for Mac, Linux and Windows (WSL2), from GitHub Releases, checked against SHA256SUMS.
- **Easier first run**: the welcome card signs Claude Code or Codex in with one tap, from your phone.
- **Folder list**: New chat, group chats and templates list the computer's folders to tap, with a path field under them.
- **Bookmarks**: bookmark any message; Bookmarks in the sidebar lists them from every chat and machine.
- Messages keep flowing to the agent while its helpers work in the background (Settings → Agents → Teamwork).
- An agent whose sign-in stopped working says so on every device, with a Sign in button that works from the phone.
