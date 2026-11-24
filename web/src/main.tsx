import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "@xterm/xterm/css/xterm.css";
import "./styles.css";
import "./styles/asks.css";
import "./styles/costs.css";
import "./styles/services.css";
import "./styles/help.css";
import "./styles/search.css";
import "./styles/welcome.css";
import "./styles/localmodels.css";
import "./styles/agentSetup.css";
import "./styles/settings.css";
import "./styles/templates.css";
import "./styles/groups.css";
import "./styles/chat-list.css";
import "./styles/signin.css";
// How the screens fit phones, foldables, tablets and computers (sizes and places only: no colours).
import "./styles/layout.css";
import "./styles/chat-settings.css";
import "./styles/together.css";
// What only a theme needs (Settings → This device → Theme): a backdrop, see-through panels, the Theme section itself.
import "./styles/themes.css";
// Last: every duration, curve and moving rule, and the Reduce Motion policy over them all.
import "./styles/motion.css";
import { App } from "./App";
import { initNative } from "./native";
import { trackSegments, trackVisualViewport } from "./viewport";
import { initZoom } from "./zoom";
import { initTheme } from "./themeDevice";
import { loadMachines, machineKey } from "./machines";
import { keepPushWorking } from "./push";
import { showInSettings } from "./navigation";
import { settingsPath } from "./settingsTabs";
import { useStore } from "./store";
import { thisDevice } from "./ui";
import { watchSpend } from "./spendNotices";
import { initMotion } from "./motion";
import { initTooltips } from "./tooltips";

// The theme saved on this device (index.html has painted it already), then its text and page size, before anything is
// measured or drawn.
initTheme();
initZoom();
trackVisualViewport();
trackSegments();
// Exact springs where they run smoothly, and no smooth scrolling under Reduce Motion.
initMotion();
// Says when an account passes 80% of its spending limit.
watchSpend();
// Icon-only buttons say what they are under a mouse.
initTooltips();

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);

void initNative();

const secure = location.protocol === "https:" || location.hostname === "localhost" || location.hostname === "127.0.0.1";
if ("serviceWorker" in navigator && secure && !location.hostname.endsWith("tauri.localhost")) {
  navigator.serviceWorker
    .register("./sw.js")
    .then(async (reg) => {
      // Notifications come through the machine this app opens from: keep them working there.
      const home = loadMachines().list.find((c) => machineKey(c) === "");
      if (!home || (await keepPushWorking(home, reg)) !== "stopped") return;
      useStore.getState().toast("warn", `Notifications stopped on ${thisDevice()}. Turn them on again in ${settingsPath("notifications")}.`, {
        // Straight to the Devices tab, where notifications are turned on again.
        action: { label: "Settings", run: () => (showInSettings("notifications"), useStore.getState().setView("settings")) },
      });
    })
    .catch(() => {});
}
