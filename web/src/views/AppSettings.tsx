import { foldKnown, foldParts, setFoldParts } from "../viewport";
import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { ChevronLeft, ChevronRight, Monitor, Plus, SquareTerminal } from "lucide-react";
import { CHAT_PROVIDERS, EFFORT_LABELS, IDLE_SIGN_OUT_DAYS, PROVIDER_INFO, idleSignOutDays, permissionInfo, type ChatProvider, type Device, type HubSettings, type ModelOption, type RoomDefaults, type ScreenStatus } from "@crosstalk/shared";
import { api, ApiError } from "../api";
import { accountKey } from "../accounts";
import { canNavigate, keepSettingsPage, settingsStartPage, takeSettingsTarget, useNavigationGuard, watchSettingsTarget } from "../navigation";
import { wentTo } from "../back";
import { PAGE_FOR_VIEW, pageForSection, SECTION_FOR_VIEW, SETTINGS_INDEX, SETTINGS_PAGES, SETTINGS_PANEL_ID, settingsAddress, settingsPage, settingsPlace, type SettingsPageId } from "../settingsTabs";
import { UsagePauseSetting } from "./SettingsPage";
import { useMachines, useStore } from "../store";
import { ConfirmButton, Stepper, Switch, timeAgo } from "../ui";
import { quietSoon } from "../quietDevices";
import { useCatalog } from "../useCatalog";
import { useReconnected } from "../useReconnected";
import { holdLayout, NARROWEST, screenWidth, setZoom, useZoom, zoomFactor, ZOOM_STEPS } from "../zoom";
import { AgentOptions, cleanChoice, type AgentChoice } from "./AgentOptions";
import { DeviceIcon, NotificationsCard, PairDialog } from "./DevicesPage";
import { ComputersCard } from "./ComputersCard";
import { StorageSection } from "./StorageSection";
import { MachinesSection } from "./MachinesSection";
import { MachineUpdates } from "./MachineUpdates";
import { ImageEditorSection } from "./ImageEditorSection";
import { MacSection } from "./MacSection";
import { AccountsList } from "./AccountsList";
import { CostsSection } from "./CostsSection";
import { LocalModelsSection } from "./LocalModelsSection";
import { MemorySection } from "./MemorySection";
import { MachinePicker, useMachineName } from "./MachinePicker";
import { GitHubCard } from "./SetupPage";
import { SidebarButton } from "./ChatSidebar";
import { HelpTip } from "./HelpTip";
import { HelpersOnCard, QuestionsCard } from "./TogetherSettings";
import { TipHeading } from "./Tip";
import { AgentSetupSection } from "./AgentSetupSection";
import { TemplatesSection } from "./TemplatesSection";
import { ThemeSection } from "./ThemeSection";
import { SettingsIndex } from "./SettingsIndex";
import { NameDialog } from "./SmallDialogs";
import { UsageMeters } from "./UsagePage";

/** The addresses that draw Settings. */
const SETTINGS_VIEWS = ["settings", "setup", "devices", "usage"];

/**
 * Settings: one list of pages (settingsTabs.ts), with what needs you and a search field above it. A page opens over
 * the list with a Back to it; every section id Settings has ever had still lands on its section, inside its page.
 */
export function AppSettings() {
  const view = useStore((s) => s.view);
  const toast = useStore((s) => s.toast);
  const several = useMachines((m) => m.list.length > 1);
  const machine = useMachineName();
  // The page on screen; null is the list of pages.
  const [page, setPage] = useState<SettingsPageId | null>(() => settingsStartPage(view));
  // The section to land on, counted so the same one asked for twice lands twice.
  const [place, setPlace] = useState<{ section: string; n: number } | null>(null);
  const asked = useRef(0);
  // A land asked for in this render: it lets the target go once drawn (below).
  const landing = useRef(false);
  const scroller = useRef<HTMLDivElement>(null);
  // The page now, for the watcher below: it's set up once and would otherwise go on seeing the page Settings opened on.
  const now = useRef(page);
  now.current = page;
  // How far down the list of pages was, so Back returns to where you were on it.
  const listScroll = useRef(0);
  // Which way the last move went: a page comes in from the right, the list comes back from the left (motion-chat.css),
  // never when Settings first opens. Their scroll and the focus move at once.
  const went = useRef<{ page: SettingsPageId | null; way: "" | "next" | "back" }>({ page, way: "" });
  if (went.current.page !== page) went.current = { page, way: page ? "next" : "back" };
  useEffect(() => {
    // Sign-ins done elsewhere (say, in a terminal on the machine) show up when Settings opens.
    api("POST", "/api/providers/refresh").catch((e) => toast("error", e instanceof Error ? e.message : String(e)));
    // Leaving Settings lets its page go; being replaced for another machine keeps it.
    return () => {
      if (!SETTINGS_VIEWS.includes(useStore.getState().view)) keepSettingsPage(null);
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  /** Another page (null: the list), asking first when this one holds unsaved changes (leaving Settings asks the same way). */
  const goPage = (id: SettingsPageId | null) => {
    if (id !== now.current && !canNavigate()) return false;
    if (now.current === null && scroller.current) listScroll.current = scroller.current.scrollTop;
    setPage(id);
    return true;
  };
  /** Opens a section's page and lands on it (a page's own name just opens it; the list's name goes back to the list). */
  const land = (name: string) => {
    if (name === SETTINGS_INDEX) return void (goPage(null) || takeSettingsTarget());
    const where = settingsPlace(name);
    // Refused (unsaved changes kept): the section asked for is let go, or the next Settings would open on it.
    if (!where || !goPage(where.page)) return void takeSettingsTarget();
    landing.current = true;
    setPlace(where.section ? { section: where.section, n: ++asked.current } : null);
  };
  useEffect(() => {
    // Where this Settings was opened to show (once): a section asked for, or the one an older address means.
    const target = takeSettingsTarget() ?? SECTION_FOR_VIEW[view];
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
  // The address changing to #/devices, #/setup or #/usage while Settings is up moves to that page, as a section's would.
  // (Compared with the last one seen, not counted: in development React runs a new screen's effects twice.)
  const viewed = useRef(view);
  useEffect(() => {
    if (viewed.current === view) return;
    viewed.current = view;
    const named = PAGE_FOR_VIEW[view];
    if (!named) return;
    setPage(named);
    const section = SECTION_FOR_VIEW[view];
    if (section) setPlace({ section, n: ++asked.current });
  }, [view]);
  const shown = useRef(page);
  useEffect(() => {
    keepSettingsPage(page);
    if (shown.current === page) {
      // Opened on this page: it's the place Settings has in the history already (the store names it), unless an older
      // address drew it (#/usage), which stays as it is so a reload opens the same.
      if (useStore.getState().view === "settings") wentTo(settingsAddress(page));
      return;
    }
    shown.current = page;
    // The address follows the page (a reload opens it again), under Settings' own name whichever older address drew it.
    if (useStore.getState().view !== "settings") {
      viewed.current = "settings";
      useStore.setState({ view: "settings" });
    }
    // A page is a place over the list: Back from it is the list when it was opened from there, else where you came from.
    wentTo(settingsAddress(page));
    // A page starts at its top, the list where it was left; and a reader lands in it rather than back at the top bar.
    if (scroller.current) scroller.current.scrollTop = page ? 0 : listScroll.current;
    scroller.current?.focus({ preventScroll: true });
  }, [page]);
  // After the page's own sections are drawn, so the one asked for is there to land on.
  useEffect(() => {
    if (!place || !scroller.current) return;
    // Another page: the land is over. There its section is only a hidden anchor, and holding it would pull you
    // straight back here; coming back later shouldn't jump to it either.
    if (pageForSection(place.section) !== page) return void setPlace(null);
    return keepInView(scroller.current, place.section);
  }, [place, page]);
  const label = page ? settingsPage(page).label : "Settings";
  return (
    <>
      <header className="topbar" data-tauri-drag-region>
        {/* The chats stay one tap away on every page (and what needs you in them shows on the button). */}
        <SidebarButton />
        {page && (
          <button className="icon-btn settings-back" onClick={() => goPage(null)} aria-label="Back to Settings" title="Back to Settings">
            <ChevronLeft size={24} aria-hidden />
          </button>
        )}
        <div className="titles">
          <h1>{label}</h1>
          <div className="sub">{page ? (several && page !== "device" ? `Settings · ${machine}` : "Settings") : machine}</div>
        </div>
        {/* Which machine's settings these are, when this device has several. On the Machines page each machine has its own place instead. */}
        {page !== "machines" && <MachinePicker />}
      </header>
      <div className="page" ref={scroller} role="region" id={SETTINGS_PANEL_ID} aria-label={label} tabIndex={-1}>
        <div className={`page-inner settings-page${went.current.way ? ` m-tab-${went.current.way}` : ""}`} key={page ?? "list"}>
          {page === null && <SettingsIndex onShow={land} />}
          {page === "accounts" && <AccountsPage />}
          {page === "new-chats" && <NewChatsPage />}
          {page === "together" && <TogetherPage />}
          {page === "usage" && <UsageCostsPage />}
          {page === "device" && <DevicePage />}
          {page === "machines" && <MachinesPage asked={place} />}
          {page === "models" && <ModelsPage />}
          <Elsewhere page={page} onShow={land} />
        </div>
      </div>
    </>
  );
}

/**
 * The sections that aren't on screen (every one, on the list of pages), as an empty line each carrying that section's
 * id. Code all over brings a section into view with `document.getElementById(id).scrollIntoView()` (the chats list's
 * Machines and Storage, Raise limit, the setup checklist's Go there): asked while that page
 * is closed, this opens the page and lands there instead, so no caller has to know Settings has pages.
 */
function Elsewhere({ page, onShow }: { page: SettingsPageId | null; onShow: (id: string) => void }) {
  return (
    <>
      {SETTINGS_PAGES.filter((p) => p.id !== page)
        .flatMap((p) => p.sections)
        .filter((s) => !s.gone)
        .map((s) => (
          <Anchor key={s.id} id={s.id} onShow={onShow} />
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

/** Who answers: every account once, in one list (plan sign-ins, API keys, other services, your own models), with one Add. */
function AccountsPage() {
  return (
    <div id="ai-services" className="settings-target">
      <AccountsList />
    </div>
  );
}

/** What a new chat starts with: each agent's model, effort and permissions, and the templates. */
function NewChatsPage() {
  return (
    <>
      <h2 className="settings-heading" id="defaults">
        What a new chat starts with
      </h2>
      {CHAT_PROVIDERS.map((p) => (
        <AgentDefaults key={p} provider={p} />
      ))}
      <p className="help">A chat can still be changed once it's started: these are only where it begins.</p>
      <TemplatesSection />
    </>
  );
}

/** Three things, a sentence each: who does helper work, agents asking another agent, agents reaching your other chats. */
function TogetherPage() {
  return (
    <>
      <HelpersOnCard />
      <QuestionsCard />
      <CrossChatCard />
    </>
  );
}

/** The plan meters first, then carrying on after a limit, then what each account cost and its spending limit. */
function UsageCostsPage() {
  return (
    <>
      <TipHeading id="usage" topic="usage">Plan limits</TipHeading>
      <UsageMeters />
      <UsagePauseSetting />
      <CostsSection />
    </>
  );
}

/** This device: its notifications, its theme, its text size, and the devices paired with the machine. */
function DevicePage() {
  return (
    <>
      <h2 className="settings-heading" id="notifications">
        Notifications
      </h2>
      <NotificationsCard />

      <h2 className="settings-heading" id="appearance">
        Theme
      </h2>
      <ThemeSection />

      <h2 className="settings-heading" id="display">
        Text size
      </h2>
      <ZoomCard />
      <FoldCard />

      <h2 className="settings-heading" id="devices">
        Paired devices
      </h2>
      <DevicesSection />
    </>
  );
}

/**
 * A foldable's own choice, shown only on a device that has reported a fold: whether a phone held half-open is laid out
 * in two parts (the chats beside the chat, or the messages above the fold). Off by default: the screen is used as one.
 */
function FoldCard() {
  const [on, setOn] = useState(foldParts);
  if (!foldKnown()) return null;
  return (
    <div className="card" style={{ marginTop: 10 }}>
      <div className="row" style={{ gap: 10, alignItems: "flex-start" }}>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div className="title">Use both halves when half-folded</div>
          <p className="help" id="fold-parts-help" style={{ margin: "2px 0 0" }}>
            With this phone held half-open, the chats go on one half and the chat on the other, or the messages above the fold and the message box below it. Off: the whole screen is used as one.
          </p>
        </div>
        <Switch
          checked={on}
          onChange={(v) => {
            setFoldParts(v);
            setOn(v);
          }}
          label="Use both halves when half-folded"
          describedBy="fold-parts-help"
        />
      </div>
    </div>
  );
}

/**
 * The machines Crosstalk runs on. The list comes first (each machine's name and link); then one machine's own things
 * under its name: this Mac's checks, its disk, GitHub, the remote computers its agents can use, its screen, and
 * Advanced. With several machines, Open on a machine's row shows that machine's things here.
 */
function MachinesPage({ asked }: { asked: { section: string; n: number } | null }) {
  const machine = useMachineName();
  const several = useMachines((m) => m.list.length > 1);
  return (
    <>
      <TipHeading id="machines" topic="machines">Machines</TipHeading>
      <MachinesSection />

      <h2 className="settings-heading" id="updates">
        Updates
      </h2>
      <MachineUpdates />

      {several && (
        <div className="machine-things" id="machine-things">
          <h2 className="machine-things-name">{machine}</h2>
          <p className="help">What follows is {machine}'s own. Tap Open on another machine above to see that one's.</p>
        </div>
      )}

      <MacSection />

      <TipHeading id="storage" topic="storage">Storage</TipHeading>
      <StorageSection />

      <h2 className="settings-heading" id="more">
        GitHub
      </h2>
      <GitHubCard />

      <div id="computers" className="settings-target" style={{ marginTop: 26 }}>
        <ComputersCard />
      </div>

      <ScreenCard />

      <AdvancedCard asked={asked} />
    </>
  );
}

/** The models that run on your own machines, and the image editor beside them (Local models links to it). */
function ModelsPage() {
  return (
    <>
      {/* Only on screen while the machine is getting full: everything it offers is on this page. */}
      <MemorySection />

      <LocalModelsSection />

      <ImageEditorSection />
    </>
  );
}

/**
 * The machine's screen: the way to the Screen page, and whether its agents may use the screen (the page's own
 * switch). A machine whose Crosstalk is older than Screen shows nothing.
 */
function ScreenCard() {
  const setView = useStore((s) => s.setView);
  const toast = useStore((s) => s.toast);
  const machine = useMachineName();
  const heard = useStore((s) => s.hub?.screen);
  const [status, setStatus] = useState<ScreenStatus | null>(null);
  const [older, setOlder] = useState(false);
  const [busy, setBusy] = useState(false);
  const request = useRef(0);
  const load = () => {
    const id = ++request.current;
    api<ScreenStatus>("GET", "/api/screen").then(
      (s) => id === request.current && setStatus(s),
      (e) => id === request.current && e instanceof ApiError && e.status === 404 && setOlder(true),
    );
  };
  useEffect(() => {
    load();
    return () => void request.current++;
  }, [heard?.ready, heard?.agents]); // eslint-disable-line react-hooks/exhaustive-deps
  useReconnected(load);
  if (older) return null;
  const put = async (agents: boolean) => {
    setBusy(true);
    try {
      setStatus(await api<ScreenStatus>("PUT", "/api/screen", { agents }));
    } catch (e) {
      toast("error", e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };
  const words = !status ? "See it live and take control" : status.ready ? "Ready: see it live and take control" : status.state === "auth" ? "Needs its password before it can be seen" : status.state === "off" ? "Not turned on yet: open it to set it up" : (status.problem ?? "See it live and take control");
  return (
    <>
      <h2 className="settings-heading" id="screen">
        Screen
      </h2>
      <div className="list-group">
        <button type="button" className="list-row settings-page-row" onClick={() => setView("screen")}>
          <span className="settings-page-icon">
            <Monitor size={20} aria-hidden />
          </span>
          <span className="row-text">
            <span className="title">See {machine}'s screen</span>
            <span className="subtitle">{words}</span>
          </span>
          <ChevronRight size={18} aria-hidden className="settings-page-chev" />
        </button>
        {status && (
          <div className="list-row settings-switch-row">
            <div className="row-text">
              <div className="title">Let agents use this screen</div>
              <div className="help" id="settings-screen-agents-help">
                Agents on {machine} can look at the screen, click and type. Off: only you can.
              </div>
            </div>
            <Switch checked={status.agents} onChange={(v) => void put(v)} disabled={busy} label="Let agents use this screen" describedBy="settings-screen-agents-help" />
          </div>
        )}
      </div>
    </>
  );
}

/**
 * Advanced, closed until asked for: a terminal on the machine, setting it up with an AI agent (one button, with the
 * commands behind "Do it by hand"), and the version it runs and where new chats' folders go. Asked for by a link (the
 * checklist's own address, #/setup, a search), it opens by itself.
 */
function AdvancedCard({ asked }: { asked: { section: string; n: number } | null }) {
  const setView = useStore((s) => s.setView);
  const hub = useStore((s) => s.hub);
  const machine = useMachineName();
  const wanted = asked?.section === "advanced" || asked?.section === "agent-setup";
  const [open, setOpen] = useState(wanted);
  useEffect(() => {
    if (wanted) setOpen(true);
  }, [wanted, asked?.n]);
  return (
    <details className="card defaults-card settings-advanced settings-target" id="advanced" open={open} onToggle={(e) => setOpen(e.currentTarget.open)}>
      <summary>
        Advanced
        <span className="defaults-picks">Terminal, setup with an AI agent, version</span>
      </summary>
      {open && (
        <>
          <div className="list-group">
            <button type="button" className="list-row settings-page-row" onClick={() => setView("terminal")}>
              <span className="settings-page-icon">
                <SquareTerminal size={20} aria-hidden />
              </span>
              <span className="row-text">
                <span className="title">Terminal</span>
                <span className="subtitle">A shell on {machine}</span>
              </span>
              <ChevronRight size={18} aria-hidden className="settings-page-chev" />
            </button>
          </div>
          <AgentSetupSection />
          <h3 className="settings-subheading">About {machine}</h3>
          <dl className="settings-facts">
            <div>
              <dt>Version</dt>
              <dd>Crosstalk {hub?.version ?? "…"}</dd>
            </div>
            <div>
              <dt>Computer name</dt>
              <dd>{hub?.hostname ?? "…"}</dd>
            </div>
            <div>
              <dt>New chats' folders go in</dt>
              <dd className="mono">{hub?.workspaceRoot ?? "…"}</dd>
            </div>
          </dl>
        </>
      )}
    </details>
  );
}

/**
 * Scrolls the page to the element `id` and keeps it there while what's above it loads in (devices, machines…), until
 * you scroll or touch something yourself, or a few seconds pass. Returns what stops it.
 */
function keepInView(page: HTMLElement, id: string): () => void {
  // A section of another page is only a hidden anchor (Elsewhere): bringing that into view would open its page.
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
  const machine = useMachineName();
  const [devices, setDevices] = useState<Device[] | null>(null);
  const [pairing, setPairing] = useState(false);
  const [renaming, setRenaming] = useState<Device | null>(null);
  const [error, setError] = useState("");
  // Days without a message before a device is signed out (0: never); null until the machine has said (an older one
  // never does, and then there's no switch).
  const [idleDays, setIdleDays] = useState<number | null>(null);
  const idleId = useId();
  const load = () => {
    setError("");
    void api<HubSettings>("GET", "/api/settings/hub")
      .then((s) => setIdleDays(idleSignOutDays(s)))
      .catch(() => {});
    return api<Device[]>("GET", "/api/devices")
      .then(setDevices)
      .catch((e) => setError(e instanceof Error ? e.message : String(e)));
  };
  // A machine that signs quiet devices out says when each last sent a message: an older one has no such switch.
  const signsOutQuiet = !!devices?.some((d) => d.lastMessageAt !== undefined) && idleDays !== null;
  const setIdle = async (on: boolean) => {
    const was = idleDays;
    setIdleDays(on ? IDLE_SIGN_OUT_DAYS : 0);
    try {
      setIdleDays(idleSignOutDays(await api<HubSettings>("PUT", "/api/settings/hub", { idleSignOutDays: on ? IDLE_SIGN_OUT_DAYS : 0 })));
    } catch (e) {
      setIdleDays(was);
      toast("error", `Couldn't save: ${e instanceof Error ? e.message : String(e)}`);
    }
  };
  useEffect(() => {
    void load();
  }, []);
  useReconnected(() => void load());
  const signOut = async (d: Device) => {
    try {
      await api("DELETE", `/api/devices/${d.id}`);
      if (d.current) disconnect();
      else await load();
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
        Shows a code and a QR code. On the new phone or computer, scan it with the camera, or open {machine}'s address and type the code.
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
            // Another machine signed in here: signed out from this list, that link would quietly break.
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
                    {quietSoon(d, idleDays)}
                  </div>
                </div>
                <div className="row-actions">
                  {link ? (
                    <button className="link-btn small" onClick={() => document.getElementById("machines")?.scrollIntoView({ behavior: "smooth", block: "start" })}>
                      Managed in Machines
                    </button>
                  ) : (
                    <>
                      <button className="btn small ghost" onClick={() => setRenaming(d)}>
                        Rename
                      </button>
                      <ConfirmButton
                        label="Sign out"
                        ariaLabel={`Sign ${d.name} out`}
                        question={d.current ? "Sign this device out? You'll need a new pairing code to come back." : `Sign "${d.name}" out?`}
                        confirmLabel="Sign out"
                        onConfirm={() => void signOut(d)}
                      />
                    </>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}
      {signsOutQuiet && (
        <div className="row quiet-signout" style={{ gap: 12, alignItems: "center", marginTop: 14 }}>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontWeight: 600 }}>Sign out devices that go quiet</div>
            <div className="help" id={idleId}>
              A phone or computer that hasn't sent a message or answered an agent for {IDLE_SIGN_OUT_DAYS} days is signed out of {machine}. It pairs again with a new code. Machines linked to this one stay.
            </div>
          </div>
          <Switch checked={(idleDays ?? 0) > 0} onChange={(on) => void setIdle(on)} label="Sign out devices that go quiet" describedBy={idleId} />
        </div>
      )}
      {pairing && <PairDialog onClose={() => (setPairing(false), void load())} />}
      {renaming && (
        <NameDialog
          title="Rename device"
          label="Device name"
          value={renaming.name}
          onSave={async (name) => {
            await api("PATCH", `/api/devices/${renaming.id}`, { name });
            await load();
          }}
          onClose={() => setRenaming(null)}
        />
      )}
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
        <AgentOptions provider={provider} value={choice} onChange={setChoice} cards />
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

export function choiceWords(provider: ChatProvider, c: Pick<AgentChoice, "model" | "effort" | "permissionMode">, models: ModelOption[], opts: { account?: string | null; permissions?: boolean; effortWord?: boolean } = {}): string {
  const name = PROVIDER_INFO[provider].name;
  const def = models.find((m) => m.isDefault);
  const model = c.model ? models.find((m) => m.id === c.model)?.label ?? c.model : `${name}'s default model${def ? ` (${def.label})` : ""}`;
  const effort = c.effort ? `${EFFORT_LABELS[c.effort] ?? c.effort}${opts.effortWord ? " effort" : ""}` : null;
  return [opts.account, model, effort, opts.permissions ? permissionInfo(provider, c.permissionMode).short : null].filter(Boolean).join(" · ");
}

/** Agents reaching the user's other chats, here and on linked machines (the machine's setting agentsAcrossChats). */
function CrossChatCard() {
  const toast = useStore((s) => s.toast);
  const hub = useStore((s) => s.hub);
  const [on, setOn] = useState<boolean | null>(null);
  // Agents on other machines messaging chats here that act without asking: this machine's own say (off unless turned on).
  const [acting, setActing] = useState(false);
  const actingId = useId();
  const [error, setError] = useState("");
  const request = useRef(0);
  const load = () => {
    const id = ++request.current;
    setError("");
    api<HubSettings>("GET", "/api/settings/hub")
      .then((s) => { if (id === request.current) { setOn(!!s.agentsAcrossChats); setActing(!!s.agentsFromMachinesAct); } })
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
  return (
    <section className="card settings-target together-card" id="other-chats" aria-label={OTHER_CHATS}>
      <div className="row">
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontWeight: 600 }}>{OTHER_CHATS}</div>
          {on === null ? (
            error ? (
              <div role="alert">
                <p className="small">Couldn't load this setting: {error}</p>
                <button className="btn small" onClick={load}>Retry</button>
              </div>
            ) : (
              <p className="muted small" role="status">Loading…</p>
            )
          ) : (
            <div className="help tip-line">
              <span>Agents can find, read and message your other chats, here and on your linked machines.</span>
              <HelpTip label="More about reaching other chats">
                A message shows in the chat it's sent to, marked with where it came from. When that chat can do more without asking than the one that sent it, you approve the message first. After 3 messages passed between agents, they ask you before going on. Reading a chat shows it to the agent that reads it. Keep a chat out of this in its own settings. Agents on a linked machine can do the same with chats here when it's on there too, once it's on on the machine they were linked from.
              </HelpTip>
            </div>
          )}
        </div>
        {on !== null && <Switch checked={on} onChange={(v) => void put(v)} label={OTHER_CHATS} />}
      </div>
      {on && (
        <div className="row" style={{ marginTop: 12, paddingTop: 12, borderTop: "0.5px solid var(--sep)" }}>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontWeight: 600 }}>Let other machines' agents drive chats that act without asking</div>
            <div className="help" id={actingId}>
              Off: a chat here above “Ask first” takes no message from an agent on another machine, and a chat such an agent starts here asks first. On: they can, as agents on this machine can. Leave it off unless you
              trust every machine linked to this one.
            </div>
          </div>
          <Switch
            checked={acting}
            onChange={async (v) => {
              setActing(v);
              try {
                setActing(!!(await api<HubSettings>("PUT", "/api/settings/hub", { agentsFromMachinesAct: v })).agentsFromMachinesAct);
              } catch (e) {
                setActing(!v);
                toast("error", e instanceof Error ? e.message : String(e));
              }
            }}
            label="Let other machines' agents drive chats that act without asking"
            describedBy={actingId}
          />
        </div>
      )}
    </section>
  );
}

const OTHER_CHATS = "Let agents reach your other chats";

