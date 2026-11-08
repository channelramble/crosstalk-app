import { useEffect, useState } from "react";
import { api, isNative, normalizeBaseUrl, pairDevice } from "../api";
import { useStore } from "../store";
import { Logo } from "../ui";

function defaultDeviceName(): string {
  const ua = navigator.userAgent;
  if (/iPhone/.test(ua)) return "iPhone";
  if (/iPad/.test(ua)) return "iPad";
  if (/Android/.test(ua)) return /Mobile/.test(ua) ? "Android phone" : "Android tablet";
  if (/Macintosh/.test(ua)) return "Mac";
  if (/Windows/.test(ua)) return "Windows PC";
  if (/Linux/.test(ua)) return "Linux PC";
  return "Browser";
}

/** Keep exactly the 8 code characters, formatted XXXX-XXXX (tolerates pasted junk and lowercase). */
function formatCode(v: string): string {
  const s = v.toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 8);
  return s.length > 4 ? `${s.slice(0, 4)}-${s.slice(4)}` : s;
}

/** Parse a pairing link like https://box.ts.net/#pair=ABCD-EFGH into hub + code. */
function parseLink(s: string): { hub?: string; code?: string } {
  try {
    const u = new URL(s.trim());
    const m = /pair=([A-Za-z0-9-]+)/.exec(u.hash + u.search);
    return { hub: u.origin, code: m?.[1] };
  } catch {
    return {};
  }
}

export function Pairing() {
  const connect = useStore((s) => s.connect);
  const [needsHub, setNeedsHub] = useState(isNative);
  const [hub, setHub] = useState(() => localStorage.getItem("crosstalk.lastHub") ?? "");
  const [code, setCode] = useState(() => formatCode(/pair=([A-Za-z0-9-]+)/.exec(location.hash)?.[1] ?? ""));
  const [name, setName] = useState(defaultDeviceName);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // When the page is served by a hub, pair with that hub; otherwise ask for its address.
  useEffect(() => {
    if (isNative) return;
    api<{ name?: string }>("GET", "/api/health", undefined, { baseUrl: "", token: "", deviceName: "" })
      .then((r) => setNeedsHub(r?.name !== "crosstalk"))
      .catch(() => setNeedsHub(true));
  }, []);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    let base = "";
    let c = code;
    if (needsHub) {
      const link = parseLink(hub);
      if (link.code && !c) c = link.code;
      base = normalizeBaseUrl(link.hub ?? hub);
      if (!base) return setError("Enter your hub's address.");
    }
    if (c.replace(/[^A-Za-z0-9]/g, "").length < 8) return setError("Enter the 8-character code.");
    setBusy(true);
    try {
      const conn = await pairDevice(base, c, name.trim() || defaultDeviceName());
      if (base) localStorage.setItem("crosstalk.lastHub", base);
      history.replaceState(null, "", location.pathname + "#/");
      await connect(conn);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="center-screen">
      <form className="card pair-card" onSubmit={submit}>
        <Logo />
        <h1>Crosstalk</h1>
        <p className="muted" style={{ marginTop: 0 }}>
          Claude Code and Codex on your own machine, from any device.
        </p>
        <div className="divider" />
        {needsHub && (
          <label className="field" style={{ textAlign: "left" }}>
            <span>Hub address</span>
            <input
              className="input"
              placeholder="https://your-box.your-tailnet.ts.net"
              value={hub}
              onChange={(e) => {
                setHub(e.target.value);
                const l = parseLink(e.target.value);
                if (l.code) setCode(formatCode(l.code));
              }}
              autoCapitalize="off"
              autoCorrect="off"
              spellCheck={false}
              inputMode="url"
            />
            <span className="help">The address your hub's installer printed. You can also paste a pairing link.</span>
          </label>
        )}
        <label className="field" style={{ textAlign: "left" }}>
          <span>Pairing code</span>
          <input
            className="input code-input"
            placeholder="XXXX-XXXX"
            value={code}
            onChange={(e) => setCode(formatCode(e.target.value))}
            autoCapitalize="characters"
            autoCorrect="off"
            spellCheck={false}
            autoFocus={!needsHub}
            inputMode="text"
          />
          <span className="help">
            Shown when the hub starts for the first time, or under <b>Settings → Devices → Pair a new device</b> on a device that's already paired. You can also run{" "}
            <span className="kbd">crosstalk-hub pair</span> on the server.
          </span>
        </label>
        <label className="field" style={{ textAlign: "left" }}>
          <span>This device's name</span>
          <input className="input" value={name} onChange={(e) => setName(e.target.value)} maxLength={60} />
        </label>
        {error && (
          <p style={{ color: "var(--red)", fontSize: 13, textAlign: "left" }} role="alert">
            {error}
          </p>
        )}
        <button className="btn primary large block" disabled={busy}>
          {busy ? "Pairing…" : "Pair this device"}
        </button>
      </form>
    </div>
  );
}
