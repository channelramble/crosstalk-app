import { useEffect, useRef, useState } from "react";
import { EFFORT_LABELS, PERMISSION_MODES, PROVIDER_INFO, leanToolsWords, permissionInfo, smallWindowWords, type ModelCatalog, type ModelOption, type PermissionMode, type Provider } from "@crosstalk/shared";
import type { Connection } from "../api";
import { accountDescription } from "../accounts";
import { listedModel, modelHelp, toolCostLine } from "../models";
import { NO_TOOLS_START, noToolsWords } from "../newChat";
import { useStore } from "../store";
import { useCatalog } from "../useCatalog";
import { Seg } from "../ui";
import { Tip } from "./Tip";
import { ModelSelectOptions } from "./ModelChoices";

/** How a chat's agent runs: which account pays, the model, how hard it thinks, and what it may do without asking. */
export interface AgentChoice {
  account: string;
  model: string;
  effort: string;
  permissionMode: PermissionMode;
  /** The model its helper agents (subagents, spawned agents) use; "" for the same model as the agent itself. */
  helperModel?: string;
}

/** Agents whose helper agents Crosstalk holds to a model: Claude Code's subagents and workflows, Codex's spawned agents. */
export const HELPER_PROVIDERS: Provider[] = ["claude", "codex"];

const CUSTOM = "__custom__";

/**
 * Account, model, effort and permissions for one agent. Models and effort levels come from the agent's own CLI.
 * `onCatalog` hears once the model list is in (null if the agent couldn't be asked): until then the menus are guesses.
 * `unset`: what no model and no effort are called, when they mean something other than the agent's own default (a
 * template's "Your default": New chat's). `offer`: models to pick from instead of asking the hub, for a server that
 * isn't an account yet (there's nothing to ask about). `starting`: a chat is about to start, so a model that can't run
 * tools says that it still can be started. `other: false` leaves out "Other…" (a typed name): Ask others offers only
 * models it can say the cost and size of.
 */
export function AgentOptions({ provider, value, onChange, showPermissions = true, showAccount = true, showHelpers = true, connection, accountList, onCatalog, unset, offer, starting = false, other = true }: { provider: Provider; value: AgentChoice; onChange: (v: AgentChoice) => void; showPermissions?: boolean; showAccount?: boolean; showHelpers?: boolean; connection?: Connection; accountList?: ReturnType<typeof useStore.getState>["accounts"]; onCatalog?: (c: ModelCatalog | null) => void; unset?: string; offer?: ModelOption[]; starting?: boolean; other?: boolean }) {
  const accounts = useStore((s) => s.accounts);
  const list = Object.values(accountList ?? accounts).filter((a) => a.provider === provider);
  // Nothing to ask the hub about while the models are given (a server found running here, not added yet).
  const { catalog, failed } = useCatalog(offer ? null : provider, value.account, connection);
  const [custom, setCustom] = useState(false);
  const set = (patch: Partial<AgentChoice>) => onChange({ ...value, ...patch });

  // When a list first comes in for this agent and account, a saved model it doesn't have gets the "Other…" field. Later
  // updates (the hub says a model came or went) only change the choices.
  const judged = useRef<string | null>(null);
  const listFor = `${connection?.baseUrl ?? ""}|${provider}|${value.account}`;
  useEffect(() => {
    if (catalog) {
      if (judged.current !== listFor) {
        judged.current = listFor;
        if (value.model && !listedModel(catalog.models, value.model)) setCustom(true);
      }
      onCatalog?.(catalog);
    } else if (failed && judged.current !== listFor) {
      judged.current = listFor;
      setCustom(!!value.model);
      onCatalog?.(null);
    }
  }, [catalog, failed, listFor]); // eslint-disable-line react-hooks/exhaustive-deps

  const models = offer ?? catalog?.models ?? [];
  const def = models.find((m) => m.isDefault);
  const chosen = custom ? undefined : value.model ? listedModel(models, value.model) : def;
  // The option that stands for the saved model: its own id, even when the model was saved as the concrete name behind
  // that id (the model row under the message box saves that), so the list shows the model instead of nothing picked.
  const selected = custom ? CUSTOM : chosen && value.model ? chosen.id : value.model;
  // A typed-in model's levels aren't known: offer every level this agent's models use.
  const levels = chosen ? chosen.efforts : custom ? [...new Set(models.flatMap((m) => m.efforts))] : [];
  // A model too small for the agent to say anything in (an 8k local model: Codex's own instructions and tools need ~12k).
  const smallWindow = chosen ? smallWindowWords(provider, chosen.label, chosen.contextWindow) : null;
  // And what the tools actually cost on it, where a request has been measured: the figure that says a model can't work with
  // this agent before a chat is started on it (Codex attaches every connector the person's ChatGPT setup offers).
  const toolCost = chosen ? toolCostLine(chosen.toolCost) : null;
  // A model of your own with room to work in, but not for the person's own Codex plugins and ChatGPT app connectors: the
  // chat runs without those (hub/src/agents/codex.ts), which is said here rather than left to be noticed in the chat.
  const account = list.find((a) => a.id === value.account) ?? (list.length === 1 ? list[0] : undefined);
  const leanTools = chosen && account?.kind === "endpoint" ? leanToolsWords(provider, chosen.label, chosen.contextWindow) : null;
  const effortValue = levels.includes(value.effort) ? value.effort : "";
  useEffect(() => {
    // A known model cannot retain an unsupported hidden effort override.
    if (catalog && chosen && value.effort && !chosen.efforts.includes(value.effort)) onChange({ ...value, effort: "" });
  }, [catalog, chosen, value.effort]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <>
      {showAccount && list.length > 1 && (
        <label className="field">
          <span>Account</span>
          <select className="select" aria-label="Account" value={value.account} onChange={(e) => { setCustom(false); set({ account: e.target.value, model: "", effort: "", ...(value.helperModel !== undefined ? { helperModel: "" } : {}) }); }}>
            {list.map((a) => (
              <option key={a.id} value={a.id}>
                {a.kind === "apikey" ? `${a.label} · API key, billed per use` : a.kind === "endpoint" ? `${a.label} · custom model` : accountDescription(a.label, a.account)}
                {a.signedIn === false ? " · not signed in" : ""}
              </option>
            ))}
          </select>
        </label>
      )}
      <label className="field">
        <span>Model</span>
        <select
          className="select"
          aria-label="Model"
          value={selected}
          onChange={(e) => {
            const v = e.target.value;
            setCustom(v === CUSTOM);
            if (v !== CUSTOM) set({ model: v });
          }}
        >
          <option value="">{unset ?? (def ? `Default (${def.label})` : `${PROVIDER_INFO[provider].name}'s default`)}</option>
          <ModelSelectOptions models={models} />
          {other && <option value={CUSTOM}>Other…</option>}
        </select>
        {custom && <input className="input" placeholder="Model name, as the agent's CLI takes it" value={value.model} onChange={(e) => set({ model: e.target.value })} autoCapitalize="off" autoCorrect="off" spellCheck={false} />}
        <span className="help">
          {modelHelp(chosen) ?? (catalog && !catalog.live ? `${PROVIDER_INFO[provider].name} couldn't be asked for its models${catalog.error ? ` (${catalog.error})` : ""}.` : offer || catalog ? "" : "Asking the agent for its models…")}
        </span>
        {/* A model the service says can't run tool calls: an agent on it can only talk, which is said before it's used
            rather than found out in the chat. */}
        {chosen?.noTools && (
          <p className="no-tools" role="note">
            {noToolsWords(chosen.label)}
            {starting ? ` ${NO_TOOLS_START}` : ""}
          </p>
        )}
        {/* A model with less room than the agent's own instructions and tools need: said here, where it's picked, because the
            first message would otherwise fail in the server's words (which blame the chat's length, not what was sent). */}
        {!chosen?.noTools && smallWindow && (
          <p className="no-tools" role="note">
            {smallWindow}
          </p>
        )}
        {/* Measured on this very model, the last time a request went to it: so it says when, and says nothing at all for a
            model no chat has used (shared ToolCost). */}
        {toolCost && (
          <p className="help model-tool-cost" role="note">
            {toolCost}
          </p>
        )}
        {/* Room to answer in, but not for the person's own Codex plugins and app connectors: this chat leaves them out. */}
        {!chosen?.noTools && !smallWindow && leanTools && (
          <p className="no-tools" role="note">
            {leanTools}
          </p>
        )}
      </label>
      {levels.length > 0 && (
        <label className="field">
          <span>Effort</span>
          <select className="select" aria-label="Effort" value={effortValue} onChange={(e) => set({ effort: e.target.value })}>
            <option value="">{unset ?? (chosen?.defaultEffort ? `Default (${EFFORT_LABELS[chosen.defaultEffort] ?? chosen.defaultEffort})` : "Default")}</option>
            {levels.map((l) => (
              <option key={l} value={l}>
                {EFFORT_LABELS[l] ?? l}
              </option>
            ))}
          </select>
          <span className="help">How hard it thinks before answering. Lower is faster and uses less of your plan.</span>
        </label>
      )}
      {showHelpers && HELPER_PROVIDERS.includes(provider) && models.length > 0 && (
        <div className="field">
          <span className="tip-line">
            <span>Helper agents</span>
            <Tip topic="helpers" />
          </span>
          <HelperSelect models={models} own={chosen?.resolvedModel ?? chosen?.id ?? (value.model || "")} value={value.helperModel ?? ""} onChange={(helperModel) => set({ helperModel })} />
          <span className="help">{helperHelp(provider)}</span>
        </div>
      )}
      {showPermissions && (
        <div className="field">
          <span className="tip-line">
            <span>Permissions</span>
            <Tip topic="permissions" />
          </span>
          <Seg value={value.permissionMode} onChange={(p) => set({ permissionMode: p })} options={PERMISSION_MODES.map((m) => ({ id: m.id, label: permissionInfo(provider, m.id).short }))} />
          <span className="help">{permissionInfo(provider, value.permissionMode).help}</span>
        </div>
      )}
    </>
  );
}

/** The effort to save: only a level the chosen model takes (switching models can make the old one invalid). */
export function cleanChoice(v: AgentChoice): AgentChoice {
  return { ...v, model: v.model.trim(), effort: v.effort.trim() };
}

/** What a provider's helper agents are, in the help under the setting. */
export function helperHelp(provider: Provider): string {
  const which = provider === "claude" ? "The subagents and workflow agents Claude Code starts" : "The agents Codex spawns";
  return `${which}. They work at the agent's own effort, and never switch models on their own.`;
}

/**
 * The model helper agents use: the agent's own, or another of its models. Saved as the full model id when the agent
 * says what an alias means (so helpers can be checked against it).
 */
export function HelperSelect({ models, own, value, onChange, label = "Helper agents use" }: { models: ModelCatalog["models"]; own: string; value: string; onChange: (v: string) => void; label?: string }) {
  const id = (m: ModelCatalog["models"][number]) => m.resolvedModel ?? m.id;
  const current = value ? models.find((m) => m.id === value || m.resolvedModel === value) : undefined;
  return (
    <select className="select" aria-label={label} value={current ? id(current) : value} onChange={(e) => onChange(e.target.value)}>
      <option value="">The same model as this agent</option>
      <ModelSelectOptions models={models.filter((m) => id(m) !== own && m.id !== own)} value={id} text={(m) => m.label} />
      {value && !current && <option value={value}>{value}</option>}
    </select>
  );
}
