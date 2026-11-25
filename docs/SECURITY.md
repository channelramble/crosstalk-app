# Security: who can reach Crosstalk, and what it does about it

Crosstalk runs coding agents on your computer, so whoever can use it can use the computer. This page says how it
keeps that to you.

## How it's reached

- **Crosstalk listens on the computer itself only** (`127.0.0.1`). The installer puts Tailscale in front of it, so it
  is reachable from the devices on your own Tailscale network and from nowhere else. Don't put it behind a public
  address.
- **Every device pairs with a code.** A code works once and expires (an hour for the first one, half an hour after that).
  A device then holds its own sign-in, which the computer stores only as a fingerprint (SHA-256). Remove a device any
  time in Settings → This device → Paired devices.
- **A device that sends no message for 30 days is signed out** and has to pair again. Its line in Paired devices says
  when that's a week away. Switch it off under the same list ("Sign out devices that go quiet"). Linked machines are
  never signed out this way.
- **Wrong codes are limited per caller**: 20 in ten minutes, then that caller waits. Someone guessing can't lock you
  out.

## What a web page elsewhere can't do

A page on another site, open in your browser, can try to talk to addresses on your network. Crosstalk answers only:

- requests made under a name it knows for the computer (localhost, an IP address, the computer's own name, its
  Tailscale name, or its `publicUrl`). Anything else gets `421`.
- pages of the app itself. Other sites aren't told they may read an answer, and can't open a live connection.

The app's own pages come with a content policy: scripts only from the computer that served them, no frames, no
plug-ins. A reply's links go to the web or to mail only.

A sign-in never travels in an address, where logs would keep it: it goes in a header, or beside a live connection's
name.

## Other machines' agents

With "agents work together" on, agents on your linked machines can message chats here. A chat whose agent **acts
without asking** takes no such message unless you allow it: Settings → Agents together → "Let other machines' agents
drive chats that act without asking". A chat another machine's agent starts here asks before it acts.

## What agents on the computer can't read

Agents are real programs with real access. Crosstalk keeps Claude Code's file tools out of its own private files
(the database, keys and saved sign-ins under `~/.crosstalk`), and those files are readable by your user only. An
agent with full access can still run any command: start chats in a project's folder, and give full access only where
you'd give it to a person.

## Updates

A release's list of checksums is signed with Crosstalk's release key. The app's Update button takes a release only
with that signature, then checks the download against the list and that it says it's the version it should be. The
release is built and published by separate jobs: what builds can't publish, and what publishes runs none of the
project's code.

## For your own setup

| Variable | What it's for |
| --- | --- |
| `CROSSTALK_ALLOWED_HOSTS` | Names (comma-separated) Crosstalk should also answer to, when you reach it through your own proxy. |
| `CROSSTALK_DEV_ORIGINS` | Other pages on this machine (a dev server, `http://127.0.0.1:5173`) allowed to call it. |
| `CROSSTALK_RELEASE_KEY` | The public key of your own fork's releases, for the Update button. |

The image editor (ComfyUI) has no sign-in of its own: see [the image editor](IMAGE-EDITOR.md).

## Reporting a problem

Open an issue on GitHub. If it's something others could misuse before it's fixed, say only that you found a
security problem and how to reach you, and leave the details out of the issue.
