# Screen: see and use the machine's screen

**Screen** (in the sidebar) shows what's on the machine's screen, live, in the app. Buttons take the view to each
window, an agent's windows first. **Control** sends your taps and typing to the machine as if you sat at it. With
**Let agents use this screen** on, agents get the same: they can look at the screen, click, type and press keys, for
apps that have no command line and for dialogs waiting on the screen.

## How it works

Crosstalk doesn't capture the screen itself. It connects to the machine's own screen sharing, on the machine
(`127.0.0.1:5900`): macOS's built-in Screen Sharing, or any VNC server on Linux.

- **Why that way:** input that arrives through the system's screen sharing counts as a person's. A click from Crosstalk
  can answer the dialogs that ignore software-generated clicks (macOS's permission prompts), and Crosstalk needs no
  screen-recording or accessibility permission of its own.
- **Your phone never gets the password.** Crosstalk signs in on the machine, then passes the picture and your input straight
  through to the app (`hub/src/screen/proxy.ts`). The view is for paired devices of yours only; a linked machine can't
  reach it.
- **Agents** use tools (`screen_screenshot`, `screen_click`, `screen_type`, `screen_key`, `screen_scroll`,
  `screen_drag`, `screen_move`, `screen_windows`) through Crosstalk's own connection. They're told never to type your
  passwords, sign-in codes or keys: you type those yourself in the Screen view. Each thing an agent does on the screen
  shows as a step in its chat ("Clicked on the screen at 412, 300").

## Set it up (once, at the machine)

Turning screen sharing on is the one step Crosstalk can't do for you: the system only lets a person do it.

**Mac**

1. System Settings → General → Sharing → turn on **Screen Sharing**.
2. In Crosstalk: Screen → type the password you log in to the Mac with → **Connect**. Crosstalk fills in the account
   (the one it runs as, whose desktop is on the Mac's screen), so there's nothing else to type.

Why your Mac account and not a separate screen sharing password: macOS only shows the desktop that's on its screen to
a sign-in by the account using it. Anything else (the "VNC viewers may control screen with password" password, or
another account) gets a login screen of its own, which is not what you see at the Mac or through a remote desktop app.
If that happens, Screen says so above the picture and takes the account's password right there. The screen sharing
password is still offered ("Use a screen sharing password"), for a Mac nobody is logged in to.

**Linux**

Run a VNC server for your desktop on port 5900 (`x11vnc`, `wayvnc`, or your desktop's own screen sharing) with a
password, then type it in Screen.

The password is kept in Crosstalk's secrets file on that machine (readable only by your user) and is never sent to a
device or shown to an agent.

## Good to know

- With screen sharing on, port 5900 also answers other devices on your network and tailnet, protected by that
  password. Choose one you don't use elsewhere.
- With a mouse, Screen opens in **Control**, like a remote desktop: your mouse and keyboard are the machine's at once.
  With a finger it opens in **Watch**, where the finger moves the view and nothing reaches the machine until you choose
  Control. Either way it opens next time as you left it on that device.
- **Full screen** (the arrows button, on anything wider than a phone held upright) shows the picture alone, and in
  Chrome and Edge also sends the machine the keys a browser keeps for itself.
- On a phone in Control: tap to click, hold for a right click, two fingers to scroll. The keyboard button opens a
  field to type from, and keys a phone hasn't got (Return, Esc, Tab, arrows).
- Agents may use the screen only while the switch in Screen → Options is on. Turning it off takes the tools away from
  running agents at their next reply.
- Crosstalk looks for screen sharing when it starts and every two minutes until it's found, so Screen notices by itself
  once you turn it on.
