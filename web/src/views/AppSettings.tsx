import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { Gauge, Plus, SquareTerminal } from "lucide-react";
import { CHAT_PROVIDERS, EFFORT_LABELS, PROVIDER_INFO, permissionInfo, type ChatProvider, type Device, type HubSettings, type ModelOption, type RoomDefaults, type TeamworkSettings } from "@crosstalk/shared";
import { api } from "../api";
import { accountKey } from "../accounts";
import { canNavigate, peekSettingsTarget, takeSettingsTarget, useNavigationGuard, watchSettingsTarget } from "../navigation";
import { keepSettingsTab, lastSettingsTab, SETTINGS_PANEL_ID, SETTINGS_TABS, settingsPlace, settingsTabId, tabForSection, TAB_FOR_VIEW, type SettingsTabId } from "../settingsTabs";
import { UsagePauseSetting } from "./SettingsPage";
import { useMachines, useStore } from "../store";
import { Stepper, Switch, timeAgo } from "../ui";
import { useCatalog } from "../useCatalog";
import { useReconnected } from "../useReconnected";
import { holdLayout, NARROWEST, screenWidth, setZoom, useZoom, zoomFactor, ZOOM_STEPS } from "../zoom";
import { AgentOptions, cleanChoice, type AgentChoice } from "./AgentOptions";
import { DeviceIcon, NotificationsCard, PairDialog } from "./DevicesPage";
import { ComputersCard } from "./ComputersCard";
import { StorageSection } from "./StorageSection";
import { MachinesSection } from "./MachinesSection";
import { ModelPool } from "./ModelPool";
import { ImageEditorSection } from "./ImageEditorSection";
import { MacSection } from "./MacSection";
import { AiServicesExtras } from "./AiServices";
import { OpenCodeCard } from "./AgentInstall";
import { CostsSection } from "./CostsSection";
import { LocalModelsSection } from "./LocalModelsSection";
import { MemorySection } from "./MemorySection";
import { MachinePicker, useMachineName } from "./MachinePicker";
import { GitHubCard, ProviderCard } from "./SetupPage";
import { SidebarButton } from "./ChatSidebar";
import { TipHeading } from "./Tip";
import { AgentSetupSection } from "./AgentSetupSection";
import { TemplatesSection } from "./TemplatesSection";

/** Settings, in tabs (settingsTabs.ts): the agents and their sign-ins, the models, the machines, the devices, usage. */
export function AppSettings() {
  const hub = useStore((s) => s.hub);
  const view = useStore((s) => s.view);
  const toast = useStore((s) => s.toast);
  // The model pool's "Add a Linux machine" opens Machines → Set up a Linux machine, in the Machines tab.
  const [linuxSetup, setLinuxSetup] = useState(0);
  // The tab on screen: the one the section asked for is in, else the address's, else where this device was last.
  const [tab, setTab] = useState<SettingsTabId>(() => settingsPlace(peekSettingsTarget())?.tab ?? TAB_FOR_VIEW[view] ?? lastSettingsTab());
  // The section to land on, counted so the same one asked for twice lands twice.
  const [place, setPlace] = useState<{ section: string; n: number } | null>(null);
  const asked = useRef(0);
  // A land asked for in this render: it lets the target go once drawn (below).
  const landing = useRef(false);
  const page = useRef<HTMLDivElement>(null);
  const tabbed = useRef(false);
  // The tab now, for the watcher below: it's set up once and would otherwise go on seeing the tab Settings opened on.
  const now = useRef(tab);
  now.current = tab;
  // Which way the last move between tabs went: the new tab's settings come in from that side (motion-chat.css), never
  // when Settings first opens. Their scroll and the focus move at once, as they always did.
  const went = useRef<{ tab: SettingsTabId; way: "" | "next" | "back" }>({ tab, way: "" });
  if (went.current.tab !== tab) {
    const at = (id: SettingsTabId) => SETTINGS_TABS.findIndex((t) => t.id === id);
    went.current = { tab, way: at(tab) > at(went.current.tab) ? "next" : "back" };
  }
  useEffect(() => {
    // Sign-ins done elsewhere (say, in a terminal on the machine) show up when Settings opens.
    api("POST", "/api/providers/refresh").catch((e) => toast("error", e instanceof Error ? e.message : String(e)));
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  /** Another tab, asking first when this one holds unsaved changes (leaving Settings asks the same way). */
  const goTab = (id: SettingsTabId) => {
    if (id !== now.current && !canNavigate()) return false;
    setTab(id);
    return true;
  };
  /** Opens a section's tab and lands on it (a tab's own name just opens it). */
  const land = (name: string) => {
    const where = settingsPlace(name);
    if (!where || !goTab(where.tab)) return;
    landing.current = true;
    if (where.section) setPlace({ section: where.section, n: ++asked.current });
  };
  useEffect(() => {
    // Where this Settings was opened to show (once).
    const target = takeSettingsTarget();
    if (target) land(target);
    // Something links to a section while Settings is on screen already (the Mac strip's Details, Raise limit).
    return watchSettingsTarget(land);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    // The target is let go only once this Settings has drawn the move: a button that shows a section and switches
    // machine throws this Settings away mid-tap (App keys it by machine), and the one that takes over must still find it.
    if (!landing.current) return;
    landing.current = false;
    takeSettingsTarget();
  });
  // The address changing to #/devices or #/setup while Settings is up moves to that tab, as a section's would.
  useEffect(() => {
    const named = TAB_FOR_VIEW[view];
    if (named) setTab(named);
  }, [view]);
  useEffect(() => {
    keepSettingsTab(tab);
    if (!tabbed.current) {
      tabbed.current = true;
      return;
    }
    // A new tab starts at its top, and a reader lands in it rather than back at the tabs.
    if (page.current) page.current.scrollTop = 0;
    page.current?.focus({ preventScroll: true });
  }, [tab]);
  // The Linux setup is asked for once: MachinesSection opens it when it sees the signal, and its tab unmounts when you
  // leave it, so the signal is let go there or coming back to Machines would open the form again unasked.
  useEffect(() => {
    if (linuxSetup && tab === "machines") setLinuxSetup(0);
  }, [linuxSetup, tab]);
  // After the tab's own sections are drawn, so the one asked for is there to land on.
  useEffect(() => {
    if (!place || !page.current) return;
    // Another tab: the land is over. In that tab its section is only a hidden anchor, and holding it would pull you
    // straight back here; coming back later shouldn't jump to it either.
    if (tabForSection(place.section) !== tab) return void setPlace(null);
    return keepInView(page.current, place.section);
  }, [place, tab]);
  return (
    <>
      <header className="topbar" data-tauri-drag-region>
        <SidebarButton />
        <div className="titles">
          <h1>Settings</h1>
          <div className="sub">{hub?.name ?? hub?.hostname ?? "Hub"}</div>
        </div>
        <MachinePicker />
      </header>
      <SettingsTabRow tab={tab} onPick={goTab} />
      <div className="page" ref={page} role="tabpanel" id={SETTINGS_PANEL_ID} aria-labelledby={settingsTabId(tab)} tabIndex={-1}>
        <div className={`page-inner${went.current.way ? ` m-tab-${went.current.way}` : ""}`} key={tab}>
          {tab === "agents" && <AgentsTab />}
          {tab === "models" && <ModelsTab onSetUpLinux={() => void (goTab("machines") && setLinuxSetup((n) => n + 1))} />}
          {tab === "machines" && <MachinesTab linuxSetup={linuxSetup} />}
          {tab === "devices" && <DevicesTab />}
          {tab === "usage" && <UsageTab />}
          <p className="tiny muted" style={{ marginTop: 18 }}>
            Hub {hub?.version} · {hub?.hostname} · new chat folders go in <span className="mono">{hub?.workspaceRoot}</span>
          </p>
          <Elsewhere tab={tab} onShow={land} />
        </div>
      </div>
    </>
  );
}

/**
 * The tabs: a tablist whose row scrolls sideways when the names don't fit (a narrow phone, a big text size), so no tab
 * is ever a scroll away. Arrow keys (and Home and End) move between them, Enter or Space opens one, the same on a wide
 * screen as on a phone.
 */
function SettingsTabRow({ tab, onPick }: { tab: SettingsTabId; onPick: (tab: SettingsTabId) => void }) {
  const row = useRef<HTMLDivElement>(null);
  // The tab on screen stays in sight when the row is wider than the screen.
  useEffect(() => {
    row.current?.querySelector<HTMLElement>('[aria-selected="true"]')?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [tab]);
  const move = (e: React.KeyboardEvent<HTMLDivElement>) => {
    const step = e.key === "ArrowRight" ? 1 : e.key === "ArrowLeft" ? -1 : 0;
    if (!step && e.key !== "Home" && e.key !== "End") return;
    const tabs = [...(row.current?.querySelectorAll<HTMLButtonElement>('[role="tab"]') ?? [])];
    const at = tabs.indexOf(document.activeElement as HTMLButtonElement);
    const to = e.key === "Home" ? 0 : e.key === "End" ? tabs.length - 1 : (Math.max(at, 0) + step + tabs.length) % tabs.length;
    e.preventDefault();
    tabs[to]?.focus();
  };
  return (
    <div className="settings-tabs">
      <div className="settings-tabs-row" role="tablist" aria-label="Settings" ref={row} onKeyDown={move}>
        {SETTINGS_TABS.map((t) => (
          <button
            key={t.id}
            id={settingsTabId(t.id)}
            type="button"
            role="tab"
            aria-selected={t.id === tab}
            aria-controls={SETTINGS_PANEL_ID}
            tabIndex={t.id === tab ? 0 : -1}
            onClick={() => onPick(t.id)}
          >
            {t.label}
          </button>
        ))}
      </div>
    </div>
  );
}

/**
 * The other tabs' sections, as an empty line each carrying that section's id. Code all over brings a section into view
 * with `document.getElementById(id).scrollIntoView()` (the chats list's Machines and Storage, Raise limit, the setup
 * checklist's Go there, the model pool's Storage): asked while that tab is closed, this opens the tab and lands there
 * instead, so no caller has to know Settings has tabs.
 */
function Elsewhere({ tab, onShow }: { tab: SettingsTabId; onShow: (id: string) => void }) {
  return (
    <>
      {SETTINGS_TABS.filter((t) => t.id !== tab)
        .flatMap((t) => t.sections)
        .map((id) => (
          <Anchor key={id} id={id} onShow={onShow} />
        ))}
    </>
  );
}

function Anchor({ id, onShow }: { id: string; onShow: (id: string) => void }) {
  const show = useRef(onShow);
  show.current = onShow;
  return (
    <div
      id={id}
      className="settings-elsewhere"
      aria-hidden="true"
      ref={(el) => {
        if (el) el.scrollIntoView = () => show.current(id);
      }}
    />
  );
}

/** The agents: what's left to set up, the services and sign-ins, what new chats start with, and teamwork. */
function AgentsTab() {
  const providers = useStore((s) => s.providers);
  return (
    <>
      <AgentSetupSection />

      <h2 className="settings-heading" id="ai-services">AI services</h2>
      <AiServicesExtras />
      {CHAT_PROVIDERS.map((p) => (
        <div key={p} id={`agent-${p}`} className="settings-target">
          <ProviderCard provider={p} status={providers[p]} />
          <AgentDefaults provider={p} />
        </div>
      ))}
      <div id="agent-opencode" className="settings-target">
        <OpenCodeCard />
      </div>

      <TemplatesSection />

      <TipHeading id="teamwork" topic="teamwork">Teamwork</TipHeading>
      <TeamworkSection />
      <CrossChatCard />
      <div id="keep-going" className="settings-target">
        <KeepGoingCard />
      </div>
    </>
  );
}

/** The models that run on your own machines, and the image editor beside them (Local models links to both). */
function ModelsTab({ onSetUpLinux }: { onSetUpLinux: () => void }) {
  return (
    <>
      {/* Only on screen while the machine is getting full: everything it offers is in this tab. */}
      <MemorySection />

      <LocalModelsSection />

      <ImageEditorSection />

      <TipHeading id="model-pool" topic="modelPool">Model pool</TipHeading>
      <ModelPool onSetUpLinux={onSetUpLinux} />
    </>
  );
}

/** The machines Crosstalk runs on: the links between them, this Mac, their disks, and the tools on them. */
function MachinesTab({ linuxSetup }: { linuxSetup: number }) {
  const setView = useStore((s) => s.setView);
  const machine = useMachineName();
  return (
    <>
      <TipHeading id="machines" topic="machines">Machines</TipHeading>
      <MachinesSection linuxSetup={linuxSetup} />

      <div id="computers" style={{ marginTop: 26 }}>
        <ComputersCard />
      </div>

      <MacSection />

      <TipHeading id="storage" topic="storage">Storage</TipHeading>
      <StorageSection />

      <h2 className="settings-heading" id="more">More</h2>
      <GitHubCard />
      <div className="list-group" style={{ marginTop: 12 }}>
        <div className="list-row" role="button" tabIndex={0} onClick={() => setView("terminal")} onKeyDown={(e) => e.key === "Enter" && setView("terminal")}>
          <SquareTerminal size={20} />
          <div style={{ flex: 1 }}>
            <div className="title">Terminal</div>
            <div className="subtitle">A shell on {machine}</div>
          </div>
        </div>
      </div>
    </>
  );
}

/** This device: its text and page size, the devices paired with the hub, and notifications here. */
function DevicesTab() {
  return (
    <>
      <h2 className="settings-heading" id="display">Display</h2>
      <ZoomCard />

      <h2 className="settings-heading" id="devices">Devices</h2>
      <DevicesSection />
    </>
  );
}

/** What the agents have used, and what it costs. */
function UsageTab() {
  const setView = useStore((s) => s.setView);
  return (
    <>
      <TipHeading id="usage" topic="usage">Usage</TipHeading>
      <UsagePauseSetting />
      <button className="btn block" onClick={() => setView("usage")}><Gauge size={18} /> View usage for every account</button>
      <CostsSection />
    </>
  );
}

/**
 * Scrolls the page to the element `id` and keeps it there while what's above it loads in (devices, machines…), until
 * you scroll or touch something yourself, or a few seconds pass. Returns what stops it.
 */
function keepInView(page: HTMLElement, id: string): () => void {
  // A section of another tab is only a hidden anchor (Elsewhere): bringing that into view would open its tab.
  const show = () => {
    const el = document.getElementById(id);
    if (el?.offsetParent) el.scrollIntoView({ block: "start" });
  };
  const grew = new ResizeObserver(show);
  let timer: ReturnType<typeof setTimeout> | undefined;
  const stop = () => {
    grew.disconnect();
    clearTimeout(timer);
    for (const e of ["touchstart", "wheel", "pointerdown"]) page.removeEventListener(e, stop);
  };
  show();
  if (page.firstElementChild) grew.observe(page.firstElementChild);
  // A press counts as interacting too: the Display card's own buttons move the page, and holding it would fight them.
  for (const e of ["touchstart", "wheel", "pointerdown"]) page.addEventListener(e, stop, { passive: true });
  timer = setTimeout(stop, 4000);
  return stop;
}

/**
 * Text and page size, on this device only (zoom.ts). Each press shows the new size at once, and the − and + buttons
 * stay under your finger: they sit side by side in the middle (zooming grows the page around the middle of the screen
 * there), the page scrolls by as much as zooming moved them down or up, and they're moved back by as much as it moved
 * them sideways (chats docked beside Settings get wider too), as far as their card goes. Until you leave Settings (or
 * fold or turn the screen), the chats stay docked or in their drawer whatever the size (zoom.ts holdLayout): their
 * coming or going would move everything sideways. Docked chats that would leave Settings too narrow go into their
 * drawer, though.
 */
function ZoomCard() {
  const zoom = useZoom();
  const step = ZOOM_STEPS.indexOf(zoom.chosen);
  const buttons = useRef<HTMLDivElement>(null);
  const was = useRef<{ x: number; y: number } | null>(null);
  // How far the buttons have been moved sideways to stay put, in the page's own pixels.
  const nudge = useRef(0);
  const reset = useRef<HTMLButtonElement>(null);
  // Leaving Settings lets the layout follow the size again.
  const release = useRef<(() => void) | null>(null);
  useEffect(() => () => release.current?.(), []);
  // A fold or a turn moves everything anyway (and lets the layout follow the size again): back to the middle.
  useEffect(() => {
    let width = screenWidth();
    const resized = () => {
      if (screenWidth() === width) return;
      width = screenWidth();
      nudge.current = 0;
      for (const el of [buttons.current?.querySelector<HTMLElement>(".stepper"), reset.current]) if (el) el.style.translate = "";
    };
    window.addEventListener("resize", resized);
    return () => window.removeEventListener("resize", resized);
  }, []);
  // The buttons themselves (the size above them grows too): where their middle is, and their top.
  const where = () => {
    const group = buttons.current?.querySelector<HTMLElement>(".stepper");
    const button = group?.querySelector("button");
    if (!group || !button) return null;
    const r = group.getBoundingClientRect();
    return { group, x: r.left + r.width / 2, y: button.getBoundingClientRect().top };
  };
  useLayoutEffect(() => {
    const before = was.current;
    was.current = null;
    const now = where();
    const page = buttons.current?.closest<HTMLElement>(".page");
    if (!page || !before || !now) return;
    // Where they are on screen is in screen pixels; the page scrolls, and they move, in its own (zoomed) ones.
    const scale = zoomFactor();
    if (Math.abs(now.y - before.y) >= 1) page.scrollTop += (now.y - before.y) / scale;
    // Never out of their card, though (it can be narrower than when they last moved): each has half its spare width.
    const spare = Math.min(...[now.group, reset.current].map((el) => (el?.parentElement ? el.parentElement.getBoundingClientRect().width - el.getBoundingClientRect().width : Infinity)));
    const room = Math.max(0, spare / 2 / scale);
    const by = Math.min(room, Math.max(-room, nudge.current + (before.x - now.x) / scale));
    if (Math.abs(by - nudge.current) * scale >= 1) {
      nudge.current = by;
      // Reset goes along, so it stays lined up under them.
      for (const el of [now.group, reset.current]) if (el) el.style.translate = `${by}px`;
    }
  }, [zoom.applied]);
  const change = (percent: number) => {
    const before = zoomFactor();
    was.current = where();
    // Held from the first press (again after a fold or a turn let it go).
    release.current = holdLayout();
    setZoom(percent);
    // Kept docked at this size, the chats would leave Settings narrower than a page ever is: they go into their drawer
    // now (the buttons are moved back as for any press).
    const main = buttons.current?.closest(".main");
    if (main && main.getBoundingClientRect().width / zoomFactor() < NARROWEST) release.current();
    // Not drawn bigger or smaller (the screen is too narrow for it): nothing to keep, now or at the next fold.
    if (zoomFactor() === before) was.current = null;
  };
  if (!zoom.supported) return <p className="help">This browser can't zoom the app. Use its own zoom instead.</p>;
  return (
    <div className="card">
      <div style={{ fontWeight: 600 }}>Text and page size</div>
      <div className="help">Zooms the whole app in or out on this device. Your other devices keep their own size.</div>
      <div className="zoom-stepper" ref={buttons}>
        <Stepper label="Text and page size" value={step} min={0} max={ZOOM_STEPS.length - 1} unit={(n) => `${ZOOM_STEPS[n]}%`} onChange={(n) => change(ZOOM_STEPS[n])} />
      </div>
      <div className="zoom-reset">
        <button ref={reset} className="btn small" disabled={zoom.chosen === 100} onClick={() => change(100)} title="Back to 100%">
          Reset
        </button>
      </div>
      {zoom.applied < zoom.chosen && <p className="help" style={{ marginBottom: 0 }}>This screen is too narrow for {zoom.chosen}%, so it shows {zoom.applied}%.</p>}
    </div>
  );
}

function DevicesSection() {
  const disconnect = useStore((s) => s.disconnect);
  const toast = useStore((s) => s.toast);
  const [devices, setDevices] = useState<Device[] | null>(null);
  const [pairing, setPairing] = useState(false);
  const [error, setError] = useState("");
  const load = () => {
    setError("");
    return api<Device[]>("GET", "/api/devices")
      .then(setDevices)
      .catch((e) => setError(e instanceof Error ? e.message : String(e)));
  };
  useEffect(() => {
    void load();
  }, []);
  useReconnected(() => void load());
  const act = async (fn: () => Promise<void>) => {
    try {
      await fn();
    } catch (e) {
      toast("error", e instanceof Error ? e.message : String(e));
    }
  };
  return (
    <>
      <button className="btn primary block" onClick={() => setPairing(true)}>
        <Plus size={16} /> Pair a new device
      </button>
      <p className="help" style={{ margin: "6px 0 10px" }}>
        Shows a code and a QR code. On the new phone or computer, scan it with the camera, or open the hub's address and type the code.
      </p>
      {error && (
        <div role="alert" className="small">
          <p style={{ color: "var(--red)" }}>Couldn't load the devices: {error}</p>
          <button className="btn small" onClick={load}>
            Retry
          </button>
        </div>
      )}
      {devices && (
        <div className="list-group">
          {devices.map((d) => {
            // Another machine's hub signed in here: signed out from this list, that link would quietly break.
            const link = d.platform === "Crosstalk hub" || !!d.hubId;
            return (
              <div key={d.id} className="list-row can-wrap names-wrap" style={{ cursor: "default" }}>
                <DeviceIcon platform={d.platform} />
                <div className="row-text">
                  <div className="title">
                    {d.name} {d.current && <span className="pill blue">This device</span>}
                  </div>
                  <div className="subtitle">
                    {link ? `Machine link${d.scope === "peer" ? " (agents only)" : ""}` : d.platform || "Unknown"} · paired {timeAgo(d.createdAt)}
                    {d.lastSeenAt ? ` · active ${timeAgo(d.lastSeenAt)}` : ""}
                  </div>
                </div>
                <div className="row-actions">
                  {link ? (
                    <button className="link-btn small" onClick={() => document.getElementById("machines")?.scrollIntoView({ behavior: "smooth", block: "start" })}>
                      Managed in Machines
                    </button>
                  ) : (
                    <>
                      <button
                        className="btn small ghost"
                        onClick={() =>
                          act(async () => {
                            const name = prompt("Device name", d.name);
                            if (!name) return;
                            await api("PATCH", `/api/devices/${d.id}`, { name });
                            await load();
                          })
                        }
                      >
                        Rename
                      </button>
                      <button
                        className="btn small ghost danger"
                        onClick={() =>
                          act(async () => {
                            if (!confirm(d.current ? "Sign this device out? You'll need a new pairing code to come back." : `Sign "${d.name}" out?`)) return;
                            await api("DELETE", `/api/devices/${d.id}`);
                            if (d.current) disconnect();
                            else await load();
                          })
                        }
                      >
                        Sign out
                      </button>
                    </>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}
      <NotificationsCard />
      {pairing && <PairDialog onClose={() => (setPairing(false), void load())} />}
    </>
  );
}

/** What new chats with this agent start with: said on the row while it's closed, changed inside it. */
function AgentDefaults({ provider }: { provider: ChatProvider }) {
  const toast = useStore((s) => s.toast);
  const name = PROVIDER_INFO[provider].name;
  const [defaults, setDefaults] = useState<RoomDefaults | null>(null);
  const [choice, setChoice] = useState<AgentChoice | null>(null);
  const [saved, setSaved] = useState<AgentChoice | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [open, setOpen] = useState(false);
  const request = useRef(0);
  const dirty = !!choice && JSON.stringify(choice) !== JSON.stringify(saved);
  useNavigationGuard(dirty);
  const words = useChoiceWords(provider, saved, { permissions: true });
  const load = () => {
    const id = ++request.current;
    setError("");
    api<RoomDefaults>("GET", "/api/settings/defaults")
      .then((d) => {
        if (id !== request.current) return;
        const a = d.agent[provider];
        const c = { account: a?.account ?? "default", model: a?.model ?? "", effort: a?.effort ?? "", permissionMode: a?.permissionMode ?? "ask", helperModel: a?.helperModel ?? "" } as AgentChoice;
        setDefaults(d);
        setChoice(c);
        setSaved(c);
      })
      .catch((e) => {
        if (id !== request.current) return;
        setError(e instanceof Error ? e.message : String(e));
        // Shown, with Retry, not hidden in the closed row.
        setOpen(true);
      });
  };
  useEffect(() => {
    load();
    return () => { request.current++; };
  }, [provider]); // eslint-disable-line react-hooks/exhaustive-deps
  useReconnected(() => { if (!saved) load(); });
  const save = async () => {
    if (!choice || busy) return;
    const submitted = choice;
    const connection = useStore.getState().conn;
    setBusy(true);
    try {
      const c = cleanChoice(submitted);
      const next = await api<RoomDefaults>("PATCH", `/api/settings/defaults/${provider}`, {
        permissionMode: c.permissionMode, model: c.model || null, effort: c.effort || null, helperModel: c.helperModel || null, ...(c.account !== "default" ? { account: c.account } : {}),
      }, connection);
      setDefaults(next);
      setSaved(submitted);
      toast("info", `Saved. New ${name} chats start like this.`);
    } catch (e) {
      toast("error", e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <details className="card defaults-card" aria-label={`New ${name} chat defaults`} open={open} onToggle={(e) => setOpen(e.currentTarget.open)}>
      <summary>
        New {name} chats start with{words ? "" : "…"}
        {words && <span className="defaults-picks">{words}</span>}
      </summary>
      {error && <div role="alert"><p>Couldn't read your {name} defaults: {error}</p><button className="btn small" onClick={load}>Retry defaults</button></div>}
      {choice && defaults ? <fieldset className="settings-fields" disabled={busy}>
        <AgentOptions provider={provider} value={choice} onChange={setChoice} />
        <button className="btn small primary" disabled={busy || !dirty} onClick={save}>
          {busy ? "Saving…" : "Save"}
        </button>
      </fieldset> : !error && <p className="muted small">Loading your defaults…</p>}
    </details>
  );
}

/**
 * A choice of model and effort in words, as a closed row says it: "Opus 5.5 · High · Asks first" (with the account
 * first when it isn't the main sign-in). Null until there's a choice.
 */
function useChoiceWords(provider: ChatProvider, c: AgentChoice | null, opts: { permissions?: boolean; effortWord?: boolean } = {}): string | null {
  const { catalog } = useCatalog(provider, c?.account ?? "default");
  const account = useStore((s) => (c && c.account !== "default" ? s.accounts[accountKey(provider, c.account)]?.label ?? null : null));
  return c ? choiceWords(provider, c, catalog?.models ?? [], { ...opts, account }) : null;
}

function choiceWords(provider: ChatProvider, c: Pick<AgentChoice, "model" | "effort" | "permissionMode">, models: ModelOption[], opts: { account?: string | null; permissions?: boolean; effortWord?: boolean } = {}): string {
  const name = PROVIDER_INFO[provider].name;
  const def = models.find((m) => m.isDefault);
  const model = c.model ? models.find((m) => m.id === c.model)?.label ?? c.model : `${name}'s default model${def ? ` (${def.label})` : ""}`;
  const effort = c.effort ? `${EFFORT_LABELS[c.effort] ?? c.effort}${opts.effortWord ? " effort" : ""}` : null;
  return [opts.account, model, effort, opts.permissions ? permissionInfo(provider, c.permissionMode).short : null].filter(Boolean).join(" · ");
}

/** Agents reaching the user's other chats, here and on linked machines (the hub setting agentsAcrossChats). */
function CrossChatCard() {
  const toast = useStore((s) => s.toast);
  const hub = useStore((s) => s.hub);
  const [on, setOn] = useState<boolean | null>(null);
  const [error, setError] = useState("");
  const request = useRef(0);
  const load = () => {
    const id = ++request.current;
    setError("");
    api<HubSettings>("GET", "/api/settings/hub")
      .then((s) => { if (id === request.current) setOn(!!s.agentsAcrossChats); })
      .catch((e) => { if (id === request.current) setError(e instanceof Error ? e.message : String(e)); });
  };
  useEffect(() => {
    load();
    return () => { request.current++; };
  }, [hub?.id]); // eslint-disable-line react-hooks/exhaustive-deps
  useReconnected(() => { if (on === null) load(); });
  const put = async (v: boolean) => {
    setOn(v);
    try {
      const s = await api<HubSettings>("PUT", "/api/settings/hub", { agentsAcrossChats: v });
      setOn(!!s.agentsAcrossChats);
    } catch (e) {
      setOn(!v);
      toast("error", e instanceof Error ? e.message : String(e));
    }
  };
  if (on === null) {
    return (
      <section className="card" style={{ marginTop: 12 }} aria-label="Let agents reach your other chats">
        <div style={{ fontWeight: 600 }}>Let agents reach your other chats</div>
        {error ? (
          <div role="alert">
            <p className="small">Couldn't load this setting: {error}</p>
            <button className="btn small" onClick={load}>Retry</button>
          </div>
        ) : (
          <p className="muted small" role="status">Loading…</p>
        )}
      </section>
    );
  }
  return (
    <section className="card" style={{ marginTop: 12 }} aria-label="Let agents reach your other chats">
      <div className="row">
        <div style={{ flex: 1 }}>
          <div style={{ fontWeight: 600 }}>Let agents reach your other chats</div>
          <div className="help">
            Agents in {hub?.name ?? "this machine"}'s chats can find, read and message your other chats, here and on your linked machines, and agents on those machines can do the same with chats here (when it's on there too). Messages show in the chat they're sent to, marked with where they came from. If the receiving chat can do more without asking than the sender, you approve the message first. After 3 messages passed between agents, they ask you before going on. Reading a chat shows it to the agent that reads it. Keep a chat out of this in its settings.
          </div>
        </div>
        <Switch checked={on} onChange={(v) => void put(v)} label="Let agents reach your other chats" />
      </div>
      {on && <p className="help" style={{ marginBottom: 0 }}>Linked machines connect for this once it's on on the machine they were linked from (Settings → Machines shows each one).</p>}
    </section>
  );
}

const KEEP_GOING = "Keep going while helpers work";

/**
 * Whether your messages go straight to an agent while its helpers work (the hub setting messagesFlow): saved at once, like
 * the switches beside it, and heard from your other devices as they change it (the hub's "hub" event). It's the machine's
 * this Settings shows, as every hub-wide setting is: nothing carries one to linked machines, so the row says so. A hub that
 * doesn't have it (GET says nothing of it) gets words, not a switch that would do nothing.
 */
function KeepGoingCard() {
  // This machine's: Settings opens anew when another machine is picked, and a save still on its way goes here.
  const connection = useRef(useStore.getState().conn).current;
  const machine = useMachineName();
  const others = useMachines((m) => m.list.length > 1);
  const heard = useStore((s) => s.hub?.messagesFlow);
  const helpId = useId();
  const [on, setOn] = useState<boolean | null>(null);
  const [older, setOlder] = useState(false);
  const [error, setError] = useState("");
  const [saveError, setSaveError] = useState("");
  const [saving, setSaving] = useState(false);
  // What the hub last said: what the switch goes back to when a save fails.
  const saved = useRef(true);
  const loads = useRef(0);
  const saves = useRef(0);
  const heardTimes = useRef(0);
  const load = () => {
    const id = ++loads.current;
    setError("");
    api<HubSettings>("GET", "/api/settings/hub", undefined, connection)
      .then((s) => {
        if (id !== loads.current) return;
        setOlder(s.messagesFlow === undefined);
        saved.current = s.messagesFlow !== false;
        setOn(saved.current);
      })
      .catch((e) => { if (id === loads.current) setError(e instanceof Error ? e.message : String(e)); });
  };
  useEffect(() => {
    load();
    return () => {
      loads.current++;
      saves.current++;
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  // `older`: that machine may just have been updated.
  useReconnected(() => { if (on === null || older) load(); });
  // Changed on another device: this row shows it too. A tap here on its way goes on showing until its answer.
  useEffect(() => {
    if (typeof heard !== "boolean") return;
    heardTimes.current++;
    saved.current = heard;
    if (!saving) setOn((was) => (was === null ? was : heard));
  }, [heard]); // eslint-disable-line react-hooks/exhaustive-deps
  const put = async (v: boolean) => {
    const id = ++saves.current;
    const times = heardTimes.current;
    setOn(v);
    setSaveError("");
    setSaving(true);
    try {
      const s = await api<HubSettings>("PUT", "/api/settings/hub", { messagesFlow: v }, connection);
      // What it heard meanwhile is as new as this answer, or newer.
      if (heardTimes.current === times) saved.current = s.messagesFlow !== false;
      if (id === saves.current) setOn(saved.current);
    } catch (e) {
      if (id !== saves.current) return;
      // Back to what's saved, saying so: what's shown is always what the hub does.
      setOn(saved.current);
      setSaveError(`Couldn't save: ${(e instanceof Error ? e.message : String(e)).replace(/[.\s]*$/, "")}. Change it again to retry.`);
    } finally {
      if (id === saves.current) setSaving(false);
    }
  };
  if (on === null || older) {
    return (
      <section className="card" style={{ marginTop: 12 }} aria-label={KEEP_GOING}>
        <div style={{ fontWeight: 600 }}>{KEEP_GOING}</div>
        {older ? (
          <p className="help" style={{ marginBottom: 0 }}>Update Crosstalk on {machine} to choose this.</p>
        ) : error ? (
          <div role="alert">
            <p className="small">Couldn't load this setting: {error}</p>
            <button className="btn small" onClick={load}>Retry</button>
          </div>
        ) : (
          <p className="muted small" role="status">Loading…</p>
        )}
      </section>
    );
  }
  return (
    <section className="card" style={{ marginTop: 12 }} aria-label={KEEP_GOING}>
      <div className="row">
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontWeight: 600 }}>{KEEP_GOING}</div>
          <div className="help" id={helpId}>
            Your messages go straight to the agent. New settings apply when its helpers finish. Off: messages wait for the helpers, so new settings apply first, and you can send one sooner by tapping.
          </div>
        </div>
        <Switch checked={on} onChange={(v) => void put(v)} label={KEEP_GOING} describedBy={helpId} />
      </div>
      <p className="help">An account switch, tighter permissions or a new folder always wait.</p>
      {others && <p className="help" role="note">This doesn't reach your other machines. Each has its own: pick one at the top of Settings to change it there.</p>}
      {saveError ? (
        <p role="alert" className="small" style={{ color: "var(--red)", marginBottom: 0 }}>{saveError}</p>
      ) : (
        <p className="help" role="status" style={{ marginBottom: 0 }}>{saving ? "Saving…" : `Saves as you change it, for ${machine} only.`}</p>
      )}
    </section>
  );
}

/**
 * Teamwork: whether agents may ask each other, how often, and which model answers. Every change saves by itself, like
 * the switch: at once for the switch, a moment after the last tap for the rest (a burst of + taps saves once).
 */
function TeamworkSection() {
  // This machine's: Settings opens anew when another machine is picked, and a save still on its way goes here.
  const connection = useRef(useStore.getState().conn).current;
  const [tw, setTw] = useState<TeamworkSettings | null>(null);
  const [error, setError] = useState("");
  const [saveError, setSaveError] = useState("");
  const [saving, setSaving] = useState(false);
  const saved = useRef<TeamworkSettings | null>(null);
  const pending = useRef<TeamworkSettings | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const loads = useRef(0);
  const saves = useRef(0);
  // The newest save the hub took (answers can come back out of order).
  const savedBy = useRef(0);
  const mounted = useRef(true);
  const load = () => {
    const id = ++loads.current;
    setError("");
    api<HubSettings>("GET", "/api/settings/hub", undefined, connection)
      .then((s) => {
        if (id !== loads.current || pending.current) return;
        saved.current = s.teamwork;
        setTw(s.teamwork);
      })
      .catch((e) => { if (id === loads.current) setError(e instanceof Error ? e.message : String(e)); });
  };
  const flush = () => {
    clearTimeout(timer.current);
    const next = pending.current;
    if (!next) return;
    pending.current = null;
    const id = ++saves.current;
    setSaving(true);
    api<HubSettings>("PUT", "/api/settings/hub", { teamwork: next }, connection)
      .then((s) => {
        if (id > savedBy.current) {
          savedBy.current = id;
          saved.current = s.teamwork;
        }
        if (!mounted.current || id !== saves.current) return;
        setSaveError("");
        if (!pending.current) setTw(s.teamwork);
      })
      .catch((e) => {
        if (!mounted.current || id !== saves.current) return;
        // Back to what's saved, saying so: what's shown is always what agents get.
        pending.current = null;
        clearTimeout(timer.current);
        setTw(saved.current);
        setSaveError(`Couldn't save: ${(e instanceof Error ? e.message : String(e)).replace(/[.\s]*$/, "")}. Change it again to retry.`);
      })
      .finally(() => { if (mounted.current && id === saves.current) setSaving(false); });
  };
  // Saved once you change something: the options correcting themselves (an effort the model doesn't take) aren't you.
  const touched = useRef(false);
  const change = (next: TeamworkSettings, wait = 700) => {
    setTw(next);
    setSaveError("");
    if (!touched.current) return;
    pending.current = next;
    clearTimeout(timer.current);
    timer.current = setTimeout(flush, wait);
  };
  useEffect(() => {
    mounted.current = true;
    load();
    // Leaving Settings, or the app, doesn't lose a change still waiting to be saved.
    const hidden = () => { if (document.visibilityState === "hidden") flush(); };
    document.addEventListener("visibilitychange", hidden);
    return () => {
      document.removeEventListener("visibilitychange", hidden);
      loads.current++;
      flush();
      mounted.current = false;
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  useReconnected(() => { if (!tw) load(); });
  if (!tw) {
    return error ? (
      <div className="card" role="alert">
        <p className="small" style={{ marginTop: 0 }}>Couldn't load teamwork settings: {error}</p>
        <button className="btn small" onClick={load}>Retry</button>
      </div>
    ) : (
      <p className="muted small" role="status">Loading teamwork settings…</p>
    );
  }
  return (
    <section className="card" aria-label="Teamwork" onPointerDownCapture={() => (touched.current = true)} onKeyDownCapture={() => (touched.current = true)}>
      <div className="row">
        <div style={{ flex: 1 }}>
          <div style={{ fontWeight: 600 }}>Let agents ask each other for help</div>
          <div className="help">
            When on, Claude Code can ask Codex one focused question (and the other way round) when a second opinion really helps. The helper sees only the question, never your chat, can read the project but not change it, and isn't asked when its plan is nearly used up.
          </div>
        </div>
        <Switch checked={tw.enabled} onChange={(v) => change({ ...tw, enabled: v }, 0)} label="Let agents ask each other for help" />
      </div>
      {tw.enabled && (
        <>
          <div className="row wrap" style={{ marginTop: 12 }}>
            <div style={{ flex: "1 1 110px" }}>
              <div style={{ fontWeight: 600 }}>Questions per reply</div>
              <div className="help">How many times an agent may ask while writing one reply.</div>
            </div>
            <Stepper label="Questions per reply" value={tw.perReply} min={1} max={3} onChange={(v) => change({ ...tw, perReply: v })} />
          </div>
          <div className="row wrap" style={{ marginTop: 12 }}>
            <div style={{ flex: "1 1 110px" }}>
              <div style={{ fontWeight: 600 }}>Save the helper's plan</div>
              <div className="help">Don't ask an agent whose plan is at or above this share of a limit.</div>
            </div>
            <Stepper label="Plan limit for asking" value={Math.round(tw.skipAbovePercent / 5)} min={10} max={20} unit={(n) => `${n * 5}%`} onChange={(v) => change({ ...tw, skipAbovePercent: v * 5 })} />
          </div>
          {CHAT_PROVIDERS.map((p) => (
            <HelperChoice key={p} provider={p} value={tw.helper[p] ?? null} onChange={(h) => change({ ...tw, helper: { ...tw.helper, [p]: h } })} />
          ))}
          <p className="help">Light models and low effort keep questions cheap.</p>
        </>
      )}
      {saveError ? (
        <p role="alert" className="small" style={{ color: "var(--red)", marginBottom: 0 }}>{saveError}</p>
      ) : (
        <p className="help" role="status" style={{ marginBottom: 0 }}>{saving ? "Saving…" : "Changes save as you make them."}</p>
      )}
    </section>
  );
}

/** Which model (and effort) answers when an agent asks this one for help: said on the row, changed inside it. */
function HelperChoice({ provider, value, onChange }: { provider: ChatProvider; value: { model: string | null; effort: string | null } | null; onChange: (v: { model: string | null; effort: string | null }) => void }) {
  const choice: AgentChoice = { account: "default", model: value?.model ?? "", effort: value?.effort ?? "", permissionMode: "ask" };
  const words = useChoiceWords(provider, choice, { effortWord: true });
  return (
    <details className="defaults-card" style={{ marginTop: 10 }} aria-label={`${PROVIDER_INFO[provider].name} helper model`}>
      <summary>
        {PROVIDER_INFO[provider].name} answers with
        <span className="defaults-picks">{words}</span>
      </summary>
      <AgentOptions
        provider={provider}
        showPermissions={false}
        showAccount={false}
        showHelpers={false}
        value={choice}
        onChange={(c) => onChange({ model: c.model.trim() || null, effort: c.effort || null })}
      />
    </details>
  );
}
