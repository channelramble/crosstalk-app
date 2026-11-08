import { useEffect, useRef } from "react";
import { Terminal as XTerm } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import type { PtyInfo } from "@crosstalk/shared";
import { api } from "../api";
import { machineName, onPtyData, useStore } from "../store";
import { onZoom, screenWidth, zoomFactor } from "../zoom";
import { newerThan, oneTimeCode, plainText } from "../terminalText";

// xterm maps clicks and taps in unzoomed pixels, so it sits outside the page's zoom (styles.css .term-unzoom) and the
// text and page size goes into its font instead.
const fontSize = () => (screenWidth() <= 760 ? 12 : 13) * zoomFactor();

/**
 * A live view of a hub terminal session. Keystrokes go straight to the process on the hub (while the hub can't be
 * reached, the box refuses them and says so). Its output is read again
 * whole when the connection comes back or the app is looked at again, so going to Safari to sign in (where the phone
 * may drop the connection) never leaves it frozen.
 */
export function Terminal({ ptyId, tall, onUrl, onCode, takeFocus = true }: { ptyId: string; tall?: boolean; onUrl?: (urls: string[]) => void; onCode?: (code: string) => void; takeFocus?: boolean }) {
  const box = useRef<HTMLDivElement>(null);
  const sendPty = useStore((s) => s.sendPty);
  const resizePty = useStore((s) => s.resizePty);
  const connected = useStore((s) => s.status === "open");
  const machine = useStore((s) => (s.conn ? machineName(s.conn, s.hub) : "the hub"));

  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const term = new XTerm({
      fontFamily: 'ui-monospace, "SF Mono", Menlo, Consolas, monospace',
      fontSize: fontSize(),
      cursorBlink: true,
      convertEol: false,
      scrollback: 5000,
      theme: { background: "#000000", foreground: "#e8e8ea", cursor: "#3d95ff", selectionBackground: "#3d95ff55" },
      allowProposedApi: true,
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(el);
    let text = "";
    const seenUrls = new Set<string>();
    let lastCode = "";
    const scan = (chunk: string) => {
      if (!onUrl && !onCode) return;
      text = (text + chunk).slice(-40000);
      if (onUrl) {
        // Prefer OSC 8 hyperlinks (ESC ] 8 ; params ; URL BEL|ST): they carry the full, unwrapped URL.
        const osc = [...text.matchAll(/\x1b\]8;[^;\x07\x1b]*;(https?:\/\/[^\x07\x1b]+)(?:\x07|\x1b\\)/g)].map((m) => m[1]);
        let urls = osc;
        if (!urls.length) {
          // Programs that hard-wrap long URLs: join wrapped lines before matching.
          const flat = plainText(text).replace(/\r?\n(?=[\w%&=./?#-]{8,})/g, "");
          urls = [...flat.matchAll(/https?:\/\/[^\s"'<>]+/g)].map((m) => m[0].replace(/[).,]+$/, ""));
        }
        const fresh = urls.filter((u) => !seenUrls.has(u));
        if (fresh.length) {
          fresh.forEach((u) => seenUrls.add(u));
          onUrl([...seenUrls]);
        }
      }
      if (onCode) {
        const code = oneTimeCode(plainText(text));
        if (code && code !== lastCode) {
          lastCode = code;
          onCode(code);
        }
      }
    };
    const doFit = () => {
      try {
        fit.fit();
        resizePty(ptyId, term.cols, term.rows);
      } catch {
        // element not visible yet
      }
    };
    requestAnimationFrame(doFit);
    // A new size (a foldable unfolding past phone width, the page zoomed) can mean another text size, then a new fit.
    const refit = () => {
      if (term.options.fontSize !== fontSize()) term.options.fontSize = fontSize();
      doFit();
    };
    const ro = new ResizeObserver(refit);
    ro.observe(el);
    const offZoom = onZoom(refit);
    let alive = true;
    // Live output while the whole output is being fetched waits, so nothing shows twice or out of order.
    let waiting: string[] | null = null;
    let reads = 0;
    const read = (again: boolean) => {
      const id = ++reads;
      waiting = [];
      api<{ info: PtyInfo; scrollback: string }>("GET", `/api/pty/${ptyId}`)
        .then((r) => {
          if (!alive || id !== reads) return;
          const later = newerThan(r.scrollback, waiting ?? []);
          waiting = null;
          if (again) {
            term.reset();
            text = "";
          }
          term.write(r.scrollback);
          scan(r.scrollback);
          for (const d of later) {
            term.write(d);
            scan(d);
          }
          if (!r.info.alive) term.write(`\r\n\x1b[90m[process exited${r.info.exitCode !== null ? ` with code ${r.info.exitCode}` : ""}]\x1b[0m\r\n`);
        })
        .catch(() => {
          if (!alive || id !== reads) return;
          const held = waiting ?? [];
          waiting = null;
          for (const d of held) term.write(d);
          // Reading it again failed (the connection is still down): what's shown stays, and the next try reads it.
          if (!again) term.write("\x1b[31mThis terminal has closed.\x1b[0m\r\n");
        });
    };
    read(false);
    const off = onPtyData(ptyId, (d) => {
      if (waiting) {
        waiting.push(d);
        return;
      }
      term.write(d);
      scan(d);
    });
    // The connection came back: output may have been missed, so the whole of it is read again. Coming back to the app
    // with the connection still up isn't: nothing was missed (a dead one is noticed on waking, and comes back here), and
    // reading again would clear the screen, scroll it and garble a full-screen program.
    // While it's down, typing is refused (and the box says so, below) instead of going nowhere without a word: this is
    // where a password is typed for sudo, and a keystroke sent while there's no connection is simply lost.
    term.options.disableStdin = useStore.getState().status !== "open";
    const offStatus = useStore.subscribe((s, prev) => {
      if (s.status !== prev.status) term.options.disableStdin = s.status !== "open";
      if (s.status === "open" && prev.status !== "open") read(true);
    });
    const sub = term.onData((d) => sendPty(ptyId, d));
    // Not for one watched in passing (an install beside a form): a phone would open its keyboard over what's being read.
    if (takeFocus) term.focus();
    return () => {
      alive = false;
      off();
      offStatus();
      sub.dispose();
      ro.disconnect();
      offZoom();
      term.dispose();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ptyId]);

  return (
    <div className={`term-box ${tall ? "tall" : ""}`}>
      {!connected && (
        <p className="term-offline" role="status">
          Not connected to {machine}. What you type here goes nowhere until it's back.
        </p>
      )}
      <div className="term-unzoom" ref={box} />
    </div>
  );
}
