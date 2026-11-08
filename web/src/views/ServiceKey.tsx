// A reply Crosstalk's own agent or OpenCode couldn't get because its AI service refused the key (shared serviceKeyWords:
// "NanoGPT refused the key — check it in Settings → AI services, then tap Try again."). The way out is the key, in Settings →
// AI services, where the service's row has Test (it checks the key) and Change (it replaces it). Never a sign-in: those
// agents have none (shared agentHasSignIn), so this is what their chats offer where another agent's would offer Sign in.
import { KeyRound } from "lucide-react";
import { isServiceKeyRefusal } from "@crosstalk/shared";
import { showInSettings, takeSettingsTarget } from "../navigation";
import { useStore } from "../store";

/** Settings → AI services, on the machine on screen: where a service's key is checked and changed. */
export function openAiServices() {
  showInSettings("ai-services");
  useStore.getState().setView("settings");
  // Refused (an editor with unsaved changes asked, and was kept): the target isn't left for the next time Settings opens.
  if (useStore.getState().view !== "settings") takeSettingsTarget();
}

/** "Open AI services", beside Try again on a reply whose service refused the key; nothing for any other failure. */
export function OpenAiServices({ error }: { error?: string | null }) {
  if (!isServiceKeyRefusal(error)) return null;
  return (
    <button type="button" className="link-action open-ai-services" onClick={openAiServices}>
      <KeyRound size={12} aria-hidden="true" /> Open AI services
    </button>
  );
}
