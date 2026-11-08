import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { homedir } from "node:os";
import { baseModelId } from "@crosstalk/shared";

/**
 * Agents keep the model and effort the user picked: they never switch on their own, and the helper agents they start
 * (Claude Code's subagents and workflow agents, Codex's spawned agents) use the chat's model and effort too, unless the
 * user picks a model for helpers (in the chat's model menu, or by asking in the chat).
 */

/** A model id without its context-window suffix, for comparing: "claude-opus-5-5[1m]" → "claude-opus-5-5". */
export function baseModel(id: string): string {
  return baseModelId(id);
}

export function sameModel(a: string, b: string): boolean {
  return baseModel(a) === baseModel(b);
}

/**
 * Claude Code's own names for "whatever it picks" ("default") and its aliases, with or without a context-window suffix
 * ("opus[1m]"): what they stand for is worked out when a process starts, so a chat keeps the one it began with.
 */
export function isModelAlias(model: string): boolean {
  return /^(?:opus|sonnet|haiku|fable|default)(?:\[[^\]]*\])?$/i.test(model);
}

/** A model id as people say it: "claude-opus-5-5" → "Opus 5.5", "claude-haiku-4-5-20251001" → "Haiku 4.5". */
export function modelName(id: string): string {
  const m = /^claude-([a-z]+)-(\d+)(?:-(\d{1,2}))?(?:-\d{8})?$/.exec(baseModel(id));
  if (!m) return id;
  return `${m[1][0].toUpperCase()}${m[1].slice(1)} ${m[2]}${m[3] ? `.${m[3]}` : ""}`;
}

/** The MCP tool an agent calls when the user asks in the chat for helpers on another model. */
export const HELPER_TOOL = "use_helper_model";

/** What an agent is told about its helpers (added to its standing instructions). */
export function helperNote(provider: "claude" | "codex", helperModel: string | null, canAsk = true): string {
  const which = helperModel ? `run on ${modelName(helperModel)} (the user picked it for helpers) at this chat's effort` : "run on this chat's model and effort";
  const how =
    provider === "claude"
      ? "Don't set a model or effort for subagents or workflow agents."
      : "When you spawn an agent, leave out `model` and `reasoning_effort`: Crosstalk's agent roles set them.";
  const ask = canAsk ? ` If the user asks in this chat for helpers on another model, call ${HELPER_TOOL}; for another effort, they change this chat's effort.` : " If the user wants a different model or effort for helpers, explain that they must change this chat's model or effort in its settings first.";
  return `Helper agents you start ${which}. ${how}${ask}`;
}

/**
 * Comments and the insides of string literals blanked out, so a search finds only code ("effort:" in a prompt's text
 * isn't an option). Good enough for workflow scripts: regular-expression literals aren't recognized.
 */
export function codeOnly(src: string): string {
  let out = "";
  let depth = 0;
  const open: number[] = []; // brace depth at each `${` still open in a template literal
  const n = src.length;
  // Skips template text up to the closing backtick, or up to `${` (whose code is kept).
  const template = (j: number): number => {
    while (j < n) {
      if (src[j] === "\\") j += 2;
      else if (src[j] === "`") {
        out += "``";
        return j + 1;
      } else if (src[j] === "$" && src[j + 1] === "{") {
        out += "`${";
        open.push(depth);
        return j + 2;
      } else j++;
    }
    return n;
  };
  let i = 0;
  while (i < n) {
    const c = src[i];
    if (c === "/" && src[i + 1] === "/") {
      while (i < n && src[i] !== "\n") i++;
    } else if (c === "/" && src[i + 1] === "*") {
      const end = src.indexOf("*/", i + 2);
      i = end < 0 ? n : end + 2;
      out += " ";
    } else if (c === "'" || c === '"') {
      const start = ++i;
      while (i < n && src[i] !== c && src[i] !== "\n") i += src[i] === "\\" ? 2 : 1;
      const value = src.slice(start, i);
      i++;
      // Quoted object keys and bracket properties are code, unlike strings inside prompts.
      const key = value === "effort" && (/^\s*:/.test(src.slice(i)) || /\[\s*$/.test(out));
      out += c + (key ? value : "") + c;
    } else if (c === "`") {
      i = template(i + 1);
    } else if (c === "}" && open.length && depth === open[open.length - 1]) {
      open.pop();
      out += "}`";
      i = template(i + 1);
    } else {
      if (c === "{") depth++;
      else if (c === "}") depth--;
      out += c;
      i++;
    }
  }
  return out;
}

/** Whether a workflow script sets the effort of its agents (or phases): `effort: 'low'`, `{ effort }`, `opts.effort = …`. */
export function setsEffort(script: string): boolean {
  const code = codeOnly(script).replace(/\b(?:const|let|var)\s*\{[^{}]*\}\s*=/g, "");
  // An effort schema (`effort: { type: ... }`) describes data; destructuring only reads a value.
  return /(?:^|[{,\s])["']?effort["']?\s*:(?!\s*\{)|[{,]\s*effort\s*[,}]|\.effort\s*=(?!=)|\[\s*["']effort["']\s*\]\s*(?::|=(?!=))/m.test(code);
}

export function effortRefusal(effort: string | undefined): string {
  const level = effort ? `the effort the user picked for this chat (${effort})` : "this chat's effort";
  return `Crosstalk: helper agents in this chat work at ${level}. Take \`effort\` out of the agent() options (and phases) and run the workflow again. If the user wants helpers to think less or more, they change the chat's effort.`;
}

/**
 * `crosstalk-hub hook workflow`: Claude Code's PreToolUse hook for the Workflow tool. Exit 2 refuses the call and
 * hands Claude Code what's written to stderr; exit 0 lets it run.
 */
function definitionRoots(cwd: string): string[] {
  const roots: string[] = [];
  let dir = resolve(cwd);
  while (true) {
    roots.push(join(dir, ".claude"));
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  const config = process.env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude");
  roots.push(config);
  try {
    const installed = JSON.parse(readFileSync(join(config, "plugins", "installed_plugins.json"), "utf8"));
    for (const entries of Object.values(installed.plugins ?? {})) for (const entry of Array.isArray(entries) ? entries : []) {
      if (typeof entry.installPath === "string") roots.push(entry.installPath);
    }
  } catch { /* No installed plugins. */ }
  return roots;
}

function definition(roots: string[], kind: "agents" | "skills" | "workflows", name: string): string | null {
  if (!/^[\w.:-]+$/.test(name)) return null;
  const short = name.split(":").pop()!;
  const suffixes = kind === "skills" ? [join(short, "SKILL.md"), `${short}.md`] : kind === "agents" ? [`${short}.md`] : [`${short}.js`, `${short}.ts`, `${short}.mjs`];
  for (const root of roots) for (const suffix of suffixes) {
    try { return readFileSync(join(root, kind, suffix), "utf8"); } catch { /* Next scope. */ }
  }
  return null;
}

function changesDefinitionSettings(src: string, skill = false): boolean {
  const head = /^---\s*\r?\n([\s\S]*?)\r?\n---/.exec(src)?.[1] ?? "";
  return /^\s*effort\s*:/m.test(head) || skill && /^\s*model\s*:/m.test(head);
}

export async function runHook(kind: string | undefined): Promise<number> {
  if (kind !== "workflow") return 0;
  let input: { cwd?: string; tool_name?: string; tool_input?: Record<string, unknown> };
  try { input = JSON.parse(await Bun.stdin.text()); } catch { return 0; }
  const ti = input.tool_input ?? {};
  const roots = definitionRoots(input.cwd ?? process.cwd());
  const refused = (detail?: string) => {
    process.stderr.write(detail ?? effortRefusal(process.env.CROSSTALK_EFFORT || undefined));
    return 2;
  };
  if (["Agent", "Task", "Skill"].includes(input.tool_name ?? "")) {
    const skill = input.tool_name === "Skill";
    const name = skill ? ti.skill : ti.subagent_type;
    const src = typeof name === "string" ? definition(roots, skill ? "skills" : "agents", name) : null;
    if (src && changesDefinitionSettings(src, skill)) return refused(`Crosstalk: ${name} sets its own ${skill ? "model or effort" : "effort"}. Use a helper or skill that inherits this chat's settings, or remove that override from its definition.`);
    return 0;
  }
  let script = typeof ti.script === "string" ? ti.script : "";
  if (!script && typeof ti.scriptPath === "string") {
    try { script = readFileSync(resolve(input.cwd ?? process.cwd(), ti.scriptPath), "utf8"); } catch { return 0; }
  }
  if (!script && typeof ti.name === "string") {
    script = definition(roots, "workflows", ti.name) ?? "";
    if (!script) return refused("Crosstalk couldn't check that saved workflow's helper settings. Run it with scriptPath or inline script so the model and effort lock can check it first.");
  }
  const nestedEffort = (value: unknown): boolean => !!value && typeof value === "object" && Object.entries(value).some(([key, child]) => key === "effort" || nestedEffort(child));
  if (nestedEffort(ti.args) || script && setsEffort(script)) return refused();
  for (const match of script.matchAll(/\bagentType\s*:\s*["']([\w.:-]+)["']/g)) {
    const src = definition(roots, "agents", match[1]);
    if (src && changesDefinitionSettings(src)) return refused(`Crosstalk: the ${match[1]} agent definition overrides this chat's effort. Use an agent type that inherits its effort.`);
  }
  return 0;
}

/** A command line for a shell (Claude Code runs hook commands through one). */
export function shellCommand(parts: string[]): string {
  return parts.map((p) => (/^[\w@%+=:,./-]+$/.test(p) ? p : `'${p.replace(/'/g, `'\\''`)}'`)).join(" ");
}

interface NamedModel {
  id: string;
  label: string;
}

const flat = (x: string) => x.toLowerCase().replace(/[\s._()-]+/g, "");

/** The model someone means by "sonnet", "Haiku 4.5" or "claude-opus-4-8": an exact id or name first, then the closest. */
export function pickModel<T extends NamedModel>(models: T[], said: string): T | null {
  const w = said.trim().toLowerCase();
  if (!w) return null;
  const f = flat(w.replace(/^claude[\s-]+/, ""));
  return (
    models.find((m) => m.id.toLowerCase() === w || m.label.toLowerCase() === w) ??
    models.find((m) => flat(m.label) === f || flat(m.id) === f || flat(m.id.replace(/^claude-/, "")) === f) ??
    models.find((m) => flat(m.label).startsWith(f)) ??
    models.find((m) => flat(m.label).includes(f) || flat(m.id).includes(f)) ??
    null
  );
}

/** "sonnet" for Sonnet 5.5: the word a model's family goes by. */
function family(m: NamedModel): string | null {
  const s = `${m.label} ${m.id}`.toLowerCase();
  return /\b(fable|opus|sonnet|haiku)\b/.exec(s.replace(/claude-/g, "claude "))?.[1] ?? /[a-z]{3,}/.exec(m.label.toLowerCase())?.[0] ?? null;
}

/**
 * Whether the human's own words name this model: its family ("use sonnet for the helpers"), and its version too when
 * it's the chat's own family (asking for "opus" in an Opus 5.5 chat doesn't say Opus 4.8).
 */
export function userNamed(words: string, target: NamedModel, chat: NamedModel | null | undefined): boolean {
  // An incidental mention, quotation, question or negative instruction is not permission to change a paid model.
  const said = words.replace(/```[\s\S]*?```/g, " ").replace(/`[^`]*`/g, " ").replace(/"[^"]*"|“[^”]*”/g, " ").split("\n")
    .filter((line) => !/^\s*>/.test(line)).join(" ").toLowerCase();
  const fam = family(target);
  if (!fam) return false;
  // Claude models go by a family word ("sonnet"); others (Codex's "gpt-6.1-sol") only by their whole name.
  const byFamily = /\b(fable|opus|sonnet|haiku)\b/.test(`${target.label} ${target.id}`.toLowerCase().replace(/claude-/g, "claude "));
  const sentences = said.split(/[;\n]+|\.(?:\s|$)/);
  const version = /(\d+)[.-](\d+)/.exec(`${target.label} ${target.id}`);
  return sentences.some((sentence) => {
    if (sentence.includes("?") || /\b(?:not|never|don['’]t|do\s+not|avoid|without|would|could|should|whether|why|how|is|are)\b/.test(sentence)) return false;
    if (!/(?:^|[,：:]\s*|\band\s+)(?:\s*please\s+|\s*i want (?:you )?to\s+|\s*)(?:use|set|put|switch|move|run|spawn|start|change|pick)\b/.test(sentence)) return false;
    if (!/\b(?:helpers?|subagents?|sub-agents?|workflow agents?)\b/.test(sentence)) return false;
    if (!byFamily) return flat(sentence).includes(flat(target.label)) || flat(sentence).includes(flat(target.id));
    if (!new RegExp(`\\b${fam}\\b`).test(sentence)) return false;
    if (!chat || family(chat) !== fam) return true;
    return !!version && new RegExp(`\\b${version[1]}\\s*[.-]\\s*${version[2]}\\b`).test(sentence);
  });
}

/** Codex's built-in helper roles, which Crosstalk replaces so every helper runs on the model and effort it sets. */
const CODEX_ROLES: Record<string, string> = {
  default: "Default agent.",
  explorer: "Use for specific codebase questions: it reads quickly and answers with what it found. Several can run at once on separate questions.",
  worker: "Use for execution and production work, such as implementing part of a feature or fixing a set of tests. Give each worker its own files.",
  awaiter: "Use to wait for a long command or task to finish and report its result.",
};

const tomlString = (v: string) => JSON.stringify(v);

/**
 * The role files for a Codex chat's helpers: the model and effort they must use (a role that sets them can't be
 * changed by the agent when it spawns one). The awaiter keeps its job of waiting, at the chat's effort.
 */
export function codexRoleFiles(model: string | null, effort: string | null): { general: string; awaiter: string } {
  const lock = [model ? `model = ${tomlString(model)}` : "", effort ? `model_reasoning_effort = ${tomlString(effort)}` : ""].filter(Boolean).join("\n");
  const awaiter = [
    lock,
    "background_terminal_max_timeout = 3600000",
    `developer_instructions = ${tomlString("You are an awaiter. Wait for the command or task you were given to finish, then report its final status and output. Don't change, reinterpret or optimize it, and don't do unrelated work.")}`,
  ].filter(Boolean).join("\n");
  return { general: `${lock}\n`, awaiter: `${awaiter}\n` };
}

/** Codex config replacing its helper roles with Crosstalk's (role files from codexRoleFiles). */
export function codexRoles(generalFile: string, awaiterFile: string): Record<string, { description: string; config_file: string }> {
  return Object.fromEntries(Object.entries(CODEX_ROLES).map(([name, description]) => [name, { description, config_file: name === "awaiter" ? awaiterFile : generalFile }]));
}
