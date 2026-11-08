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
import "./styles/templates.css";
import "./styles/groups.css";
import "./styles/signin.css";
// Last: every duration, curve and moving rule, and the Reduce Motion policy over them all.
import "./styles/motion.css";
import { App } from "./App";
import { initNative } from "./native";
import { trackSegments, trackVisualViewport } from "./viewport";
import { initZoom } from "./zoom";
import { loadMachines, machineKey } from "./machines";
import { keepPushWorking } from "./push";
import { showInSettings } from "./navigation";
import { useStore } from "./store";
import { thisDevice } from "./ui";
import { watchSpend } from "./spendNotices";
import { initMotion } from "./motion";

// The text and page size saved on this device, before anything is measured or drawn.
initZoom();
trackVisualViewport();
trackSegments();
// Exact springs where they run smoothly, and no smooth scrolling under Reduce Motion.
initMotion();
// Says when an account passes 80% of its spending limit.
watchSpend();

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
      useStore.getState().toast("warn", `Notifications stopped on ${thisDevice()}. Turn them on again in Settings → Devices.`, {
        // Straight to the Devices tab, where notifications are turned on again.
        action: { label: "Settings", run: () => (showInSettings("devices"), useStore.getState().setView("settings")) },
      });
    })
    .catch(() => {});
}
