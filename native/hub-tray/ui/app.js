// Crosstalk Hub's window. It does everything through the app's fixed commands (src-tauri/src/commands.rs) and
// gets the hub's status as a "status" event every few seconds. No build step: plain DOM, no innerHTML.
"use strict";

const tauri = window.__TAURI__;
const invoke = (cmd, args) => tauri.core.invoke(cmd, args);
const $ = (id) => document.getElementById(id);

const state = { status: null, info: null, login: null, view: "home", busy: false, installing: false };

// ---- small helpers

function el(tag, attrs = {}, ...children) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === "class") e.className = v;
    else if (k in e && typeof v !== "string") e[k] = v;
    else e.setAttribute(k, v);
  }
  e.append(...children);
  return e;
}

function toast(text) {
  const t = $("toast");
  t.textContent = text;
  t.classList.add("shown");
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => t.classList.remove("shown"), 2600);
}

async function copy(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    const ta = el("textarea", { class: "offscreen", readonly: "" });
    ta.value = text;
    document.body.append(ta);
    ta.select();
    const ok = document.execCommand("copy");
    ta.remove();
    return ok;
  }
}

/** Changes text only when it differs: the status card is a live region, read out when it changes. */
function setText(id, text) {
  const e = $(id);
  if (e.textContent !== text) e.textContent = text;
}

function minutes(seconds) {
  if (seconds == null) return "";
  const m = Math.floor(seconds / 60);
  return m < 1 ? "under a minute" : m === 1 ? "1 minute" : `${m} minutes`;
}

/** Every error says what happened and offers a way out: try again, the log, or the setting that fixes it. */
function notice(message, { tone = "error", fix = null, retry = null } = {}) {
  const box = $("notice");
  if (!message) {
    box.hidden = true;
    return;
  }
  box.classList.toggle("info", tone === "info");
  $("notice-text").textContent = message;
  const actions = $("notice-actions");
  actions.replaceChildren();
  const add = (label, fn) => {
    const b = el("button", { class: "btn small", type: "button" }, label);
    b.addEventListener("click", fn);
    actions.append(b);
  };
  if (retry) add("Try again", () => (notice(null), retry()));
  if (fix === "loginItems") add("Open Login Items", () => invoke("open_login_items").catch((e) => fail(e)));
  if (fix === "logs") add("Show logs", () => (notice(null), show("logs")));
  add("Dismiss", () => notice(null));
  box.hidden = false;
}

function fail(e, retry) {
  const p = e && typeof e === "object" ? e : { message: String(e) };
  notice(p.message || String(e), { fix: p.fix, retry: p.fix === "loginItems" ? null : retry });
}

// ---- views

const openers = { pair: makeCode, logs: loadLogs, install: loadPlan };

function show(view, step = 1) {
  state.view = view;
  for (const s of document.querySelectorAll("[data-view]")) s.hidden = s.dataset.view !== view;
  const section = document.querySelector(`[data-view="${view}"]`);
  for (const st of section.querySelectorAll("[data-step]")) st.hidden = st.dataset.step !== String(step);
  window.scrollTo(0, 0);
  section.querySelector("h2")?.focus();
  openers[view]?.();
}

/** Where the tray (or a second launch) asked the window to open. */
function openView(view) {
  const where = { home: ["home"], pair: ["pair"], logs: ["logs"], install: ["install"], stop: ["stop"], restart: ["restart"], "restart-now": ["restart"] }[view];
  if (where) show(...where);
}

/** Holds every button while an action runs, then gives each back the state it had (Install may be off on purpose). */
function setBusy(busy) {
  state.busy = busy;
  for (const b of document.querySelectorAll("[data-view] .btn[data-action]")) {
    if (b.dataset.action === "home") continue;
    if (busy) {
      b.dataset.held = String(b.disabled);
      b.disabled = true;
    } else if (b.dataset.held !== undefined) {
      b.disabled = b.dataset.held === "true";
      delete b.dataset.held;
    }
  }
}

/** Runs one of the app's actions; its answer shows briefly, an error stays until dealt with. Try again runs it again,
 * or does `retry`: Stop and Restart now go back to their last step, never straight to it. */
async function run(cmd, { then = "home", args, retry } = {}) {
  if (state.busy) return;
  setBusy(true);
  notice(null);
  try {
    const said = await invoke(cmd, args);
    if (typeof said === "string" && said) toast(said);
    if (then) show(then);
    refresh();
  } catch (e) {
    fail(e, retry ?? (() => run(cmd, { then, args })));
  } finally {
    setBusy(false);
  }
}

// ---- home

function renderStatus() {
  const s = state.status;
  if (!s) return;
  $("status-dot").dataset.tone = s.tone;
  setText("status-title", s.title);
  setText("status-detail", s.detail);
  const notInstalled = s.state === "notInstalled";
  $("row-version").hidden = notInstalled;
  $("row-address").hidden = notInstalled;
  setText(
    "fact-version",
    s.version ? (s.updateWaiting ? `${s.version} running, ${s.installedVersion} installed` : s.version) : s.installedVersion ? `${s.installedVersion} (not running)` : "–",
  );
  setText("fact-address", s.openUrl);
  $("row-restart").hidden = !s.restart;
  if (s.restart) setText("fact-restart", `Waiting for five quiet minutes (${minutes(s.restart.waited)} so far)`);
  // Stop and Restart now end a waiting restart: their last step says so.
  for (const n of document.querySelectorAll("[data-if-waiting]")) n.hidden = !s.restart;
  for (const b of document.querySelectorAll("[data-needs]")) b.hidden = !s.actions[b.dataset.needs] || (b.dataset.unless && s.actions[b.dataset.unless]);
  setText("home-install", s.state === "noService" ? "Set up the background service…" : "Install Crosstalk…");
  $("restart-quiet-card").hidden = !s.actions.restart;
  for (const n of document.querySelectorAll(".next-start")) n.textContent = s.os === "linux" ? "until the computer starts again" : "until the next login";
}

async function refresh() {
  try {
    state.status = await invoke("status");
    renderStatus();
  } catch (e) {
    fail(e, refresh);
  }
}

function renderLogin() {
  const l = state.login;
  if (!l) return;
  const t = $("login-toggle");
  t.checked = l.state === "on" || l.state === "needsApproval";
  t.disabled = l.state === "unavailable";
  const notes = {
    on: "It opens by itself when you log in. Crosstalk itself starts on its own either way.",
    off: "Off: open it yourself when you want it. Crosstalk itself starts on its own either way.",
    needsApproval: "Waiting for your OK: switch Crosstalk Hub on under Login Items.",
    unavailable: "This copy of the app can't be started at login (it isn't in Applications).",
  };
  $("login-note").textContent = notes[l.state] + (l.trial ? " Trial: a marker file, not a real login item." : "");
}

async function loadLogin() {
  try {
    state.login = await invoke("login_item");
    renderLogin();
  } catch {
    /* the switch stays as it was */
  }
}

$("login-toggle").addEventListener("change", async (e) => {
  const on = e.target.checked;
  e.target.disabled = true;
  try {
    state.login = await invoke("set_login_item", { on });
  } catch (err) {
    fail(err, () => $("login-toggle").click());
    await loadLogin();
  }
  renderLogin();
});

// ---- pair

async function makeCode() {
  $("pair-busy").textContent = "Making a code…";
  $("pair-busy").hidden = false;
  $("pair-result").hidden = true;
  try {
    const c = await invoke("pair");
    state.pair = c;
    $("pair-code").textContent = c.code;
    $("pair-base").textContent = c.base || "";
    const until = new Date(c.expiresAt).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
    $("pair-expires").textContent = `Works once · expires at ${until}`;
    const qr = $("pair-qr");
    qr.hidden = !c.qrSvg;
    if (c.qrSvg) qr.src = "data:image/svg+xml;charset=utf-8," + encodeURIComponent(c.qrSvg);
    $("pair-local").hidden = !!c.link;
    $("pair-how").hidden = !c.link;
    $("pair-copy").hidden = !c.link;
    $("pair-busy").hidden = true;
    $("pair-result").hidden = false;
  } catch (e) {
    $("pair-busy").textContent = "No code this time.";
    fail(e, makeCode);
  }
}

// ---- logs

async function loadLogs() {
  const text = $("logs-text");
  text.textContent = "Reading…";
  $("logs-open").hidden = state.info?.os !== "mac";
  try {
    const l = await invoke("logs");
    $("logs-source").textContent = l.hubSource;
    $("logs-problem").hidden = !l.problem;
    $("logs-problem").textContent = l.problem || "";
    text.textContent = l.hub || "Nothing in the log yet.";
    text.scrollTop = text.scrollHeight;
    $("logs-watcher").hidden = !l.watcher;
    $("logs-watcher-text").textContent = l.watcher || "";
  } catch (e) {
    text.textContent = "";
    fail(e, loadLogs);
  }
}

// ---- install

async function loadPlan() {
  if (state.installing) return;
  $("install-plan").hidden = false;
  $("install-progress").hidden = true;
  $("install-steps").replaceChildren();
  $("install-choices").replaceChildren();
  try {
    const p = await invoke("install_plan");
    $("install-title").textContent = p.serviceOnly ? "Set up the background service" : "Install Crosstalk";
    $("install-steps").append(...p.steps.map((s) => el("li", {}, s)));
    for (const c of p.choices) {
      const box = el("input", { type: "checkbox", id: `choice-${c.id}` });
      box.checked = c.on;
      box.disabled = state.info?.trial && c.id === "power";
      $("install-choices").append(el("label", { class: "choice", for: box.id }, box, el("span", {}, el("span", { class: "strong" }, c.label), el("br"), el("span", { class: "small muted" }, c.detail))));
    }
    $("install-why-not").hidden = p.possible;
    $("install-why-not").textContent = p.whyNot || "";
    $("install-run").disabled = !p.possible;
  } catch (e) {
    fail(e, loadPlan);
  }
}

function chosen(id) {
  const box = $(`choice-${id}`);
  return !!box && box.checked && !box.disabled;
}

async function startInstall() {
  $("install-plan").hidden = true;
  $("install-progress").hidden = false;
  $("install-after").hidden = true;
  $("install-state").textContent = "Installing… this takes a minute.";
  $("install-output").textContent = "";
  state.installing = true;
  try {
    await invoke("install", { tailscale: chosen("tailscale"), power: chosen("power") });
  } catch (e) {
    state.installing = false;
    fail(e, startInstall);
    loadPlan();
  }
}

function onInstall(ev) {
  const out = $("install-output");
  if (ev.kind === "line") {
    out.textContent += ev.text + "\n";
    out.scrollTop = out.scrollHeight;
    return;
  }
  state.installing = false;
  $("install-state").textContent = ev.message;
  const after = $("install-after");
  after.replaceChildren();
  const add = (label, cls, fn) => {
    const b = el("button", { class: `btn ${cls}`, type: "button" }, label);
    b.addEventListener("click", fn);
    after.append(b);
  };
  const fixes = { linger: "Keep it running when you log out", tailscaleOperator: "Let Tailscale publish it" };
  for (const f of ev.fixes || []) add(fixes[f] || f, "", () => invoke("install_fix", { fix: f }).then(() => ($("install-state").textContent = "Working…")).catch((e) => fail(e)));
  if (ev.ok) {
    add("Pair a phone", "primary", () => show("pair"));
    add("Done", "ghost", () => show("home"));
  } else {
    add("Try again", "primary", () => loadPlan());
    add("Show logs", "", () => show("logs"));
  }
  after.hidden = false;
  refresh();
}

// ---- actions

const actions = {
  home: () => show("home"),
  open: () => run("open_crosstalk", { then: null }),
  "copy-address": async () => toast((await copy(state.status?.openUrl || "")) ? "Address copied" : "Couldn't copy it: select it and copy by hand"),
  "go-install": () => show("install"),
  "go-pair": () => show("pair"),
  "go-logs": () => show("logs"),
  "go-stop": () => show("stop"),
  "go-restart": () => show("restart"),
  "go-restart-now": () => show("restart"),
  start: () => run("start"),
  "cancel-restart": () => run("cancel_restart"),
  "stop-1": () => show("stop", 2),
  "stop-2": () => run("stop", { retry: () => show("stop", 2) }),
  "restart-quiet": () => run("restart_when_quiet"),
  "restart-now-1": () => show("restart", 2),
  "restart-now-2": () => run("restart_now", { retry: () => show("restart", 2) }),
  "pair-again": () => makeCode(),
  "copy-link": async () => toast((await copy(state.pair?.link || "")) ? "Pairing link copied" : "Couldn't copy it"),
  "logs-refresh": () => loadLogs(),
  "logs-open": () => invoke("open_log_file").catch((e) => fail(e)),
  "login-toggle": () => $("login-toggle").click(),
  "install-run": () => startInstall(),
  hide: () => invoke("hide_window"),
  quit: () => invoke("quit"),
};

document.addEventListener("click", (e) => {
  const b = e.target.closest("[data-action]");
  if (!b || b.disabled) return;
  actions[b.dataset.action]?.(b);
});

document.addEventListener("keydown", (e) => {
  if (e.key !== "Escape") return;
  if (state.view === "home") invoke("hide_window");
  else show("home");
});

async function takeOpening() {
  try {
    const o = await invoke("take_opening");
    // A notice from the menu, whose Try again runs the same action the window's way (unless only the setting helps, as
    // in fail()); else none left from before when the window opens on another view.
    const n = o.notice;
    if (n) notice(n.message, { tone: n.tone, fix: n.fix, retry: n.retry && n.fix !== "loginItems" ? actions[n.retry] : null });
    else if (o.view) notice(null);
    if (o.view) openView(o.view);
  } catch {
    /* nothing to open */
  }
  loadLogin();
}

async function boot() {
  if (!tauri) {
    document.body.replaceChildren(el("p", { class: "muted" }, "This page is Crosstalk Hub's window: open the app instead."));
    return;
  }
  try {
    state.info = await invoke("app_info");
  } catch {
    state.info = null;
  }
  $("trial").hidden = !state.info?.trial;
  await tauri.event.listen("status", (e) => {
    state.status = e.payload;
    renderStatus();
  });
  await tauri.event.listen("opening", () => takeOpening());
  // Hidden to the menu bar or tray: an old error or a half-made Stop or Restart now doesn't wait there for later.
  await tauri.event.listen("hidden", () => {
    notice(null);
    if (state.view === "stop" || state.view === "restart") show("home");
  });
  await tauri.event.listen("install", (e) => onInstall(e.payload));
  await refresh();
  await takeOpening();
}

boot();
