import { basename, isAbsolute, resolve } from "node:path";

/** A Claude Code permission rule: a tool, and what of it (a command prefix, a path pattern, a domain). */
export interface PermissionRule {
  toolName: string;
  ruleContent?: string;
}

/**
 * A rule as Claude Code writes it in settings: `Bash(git status:*)`, `WebSearch`. Backslashes and parentheses in what
 * it allows are escaped the way Claude Code escapes them, so it reads back the very rule it was given (parseRule).
 */
export function ruleText(r: PermissionRule): string {
  if (r.ruleContent === undefined) return r.toolName;
  return `${r.toolName}(${r.ruleContent.replaceAll("\\", "\\\\").replaceAll("(", "\\(").replaceAll(")", "\\)")})`;
}

/** A rule written by ruleText, read back (null when it isn't one). */
export function parseRule(text: string): PermissionRule | null {
  const open = text.indexOf("(");
  if (open < 0) return /^[\w.:-]{1,128}$/.test(text) ? { toolName: text } : null;
  if (!text.endsWith(")") || !/^[\w.:-]{1,128}$/.test(text.slice(0, open))) return null;
  const content = text.slice(open + 1, -1).replaceAll("\\(", "(").replaceAll("\\)", ")").replaceAll("\\\\", "\\");
  return { toolName: text.slice(0, open), ruleContent: content };
}

/** What a saved rule allows, in words, for the chat's settings: "`git status` commands", "Edits to app.ts". */
export function ruleLabel(text: string): string {
  const r = parseRule(text);
  if (!r) return text;
  const c = r.ruleContent;
  // A path pattern ("//work/app/a.ts", "//work/lib/**") as the path it names.
  const path = (p: string) => p.replace(/^\//, "").replace(/\/\*\*$/, "").replace(/\\(.)/g, "$1");
  if (r.toolName === "Bash" && c !== undefined) return c.endsWith(":*") ? `\`${c.slice(0, -2)}\` commands` : `The exact command \`${c}\``;
  if (r.toolName === "Edit" && c !== undefined) return `Edits to ${path(c)}`;
  if (r.toolName === "Read" && c !== undefined) return c.endsWith("/**") ? `Reading in ${path(c)}` : `Reading ${path(c)}`;
  if (r.toolName === "WebFetch" && c?.startsWith("domain:")) return `Fetching from ${c.slice("domain:".length)}`;
  if (r.toolName === "WebSearch" && c === undefined) return "Web searches";
  const mcp = /^mcp__(.+?)__(.+)$/.exec(r.toolName);
  return mcp ? `${mcp[1]}: ${mcp[2].replace(/_/g, " ")}` : c === undefined ? r.toolName : `${r.toolName}: ${c}`;
}

/** What "Always allow" allows for one request: the rules Claude Code adds for the session, and the button's words. */
export interface AlwaysAllow {
  rules: PermissionRule[];
  label: string;
}

/**
 * "Always allow" for a request through Claude Code's permission prompt: as narrow as Claude Code's own "don't ask
 * again" choices, never the whole tool. A shell command allows commands starting with its first word or two
 * (`git status:*`), each part of a compound command on its own; an edit allows edits to that file; a fetch, that site.
 * Commands that delete, change permissions, or run other commands or code given inline are only allowed exactly as
 * they are, and one with a * in it only once. Null: this request can only be allowed once.
 */
export function alwaysAllow(toolName: string, input: Record<string, unknown>, cwd: string): AlwaysAllow | null {
  const str = (v: unknown) => (typeof v === "string" ? v.trim() : "");
  switch (toolName) {
    case "Bash":
      return bashRules(str(input.command));
    case "Edit":
    case "MultiEdit":
    case "Write":
    case "NotebookEdit": {
      const path = absolute(str(input.file_path) || str(input.notebook_path), cwd);
      if (!path) return null;
      // Claude Code's Edit rules cover every tool that edits files; "//" starts an absolute path in them.
      return { rules: [{ toolName: "Edit", ruleContent: `/${globSafe(path)}` }], label: `Always allow edits to ${basename(path)}` };
    }
    case "Read": {
      const path = absolute(str(input.file_path), cwd);
      return path ? { rules: [{ toolName: "Read", ruleContent: `/${globSafe(path)}` }], label: `Always allow reading ${basename(path)}` } : null;
    }
    case "Glob":
    case "Grep": {
      const dir = absolute(str(input.path) || cwd, cwd);
      return dir ? { rules: [{ toolName: "Read", ruleContent: `/${globSafe(dir)}/**` }], label: `Always allow reading in ${basename(dir) || dir}` } : null;
    }
    case "WebFetch": {
      let host = "";
      try {
        host = new URL(str(input.url)).hostname;
      } catch {
        return null;
      }
      return host ? { rules: [{ toolName: "WebFetch", ruleContent: `domain:${host}` }], label: `Always allow fetching from ${host}` } : null;
    }
    case "WebSearch":
      return { rules: [{ toolName: "WebSearch" }], label: "Always allow web searches" };
  }
  if (!/^[\w.:-]{1,128}$/.test(toolName)) return null;
  // A tool from an MCP server, or one of Claude Code's own (Task, Skill…): that one tool.
  const mcp = /^mcp__(.+?)__(.+)$/.exec(toolName);
  return { rules: [{ toolName }], label: mcp ? `Always allow ${mcp[1]}: ${mcp[2].replace(/_/g, " ")}` : `Always allow ${toolName}` };
}

/**
 * Programs that delete or change things for good, or run other commands or code (wrappers like `command`, `arch` or
 * `caffeinate` run the command after them; awk runs the program it's given): only their exact command is allowed.
 * Shell keywords (`if`, `then`, `do`…) start a part of a compound command whose real program comes after them.
 */
const EXACT_ONLY = new Set([
  "rm", "rmdir", "unlink", "shred", "dd", "mkfs", "diskutil", "sudo", "sudoedit", "su", "doas", "pkexec", "runuser", "chmod", "chown", "chgrp",
  "kill", "killall", "pkill", "launchctl", "systemctl", "systemd-run", "shutdown", "reboot", "halt", "eval", "exec", "source", ".", "xargs",
  "env", "nohup", "nice", "ionice", "timeout", "time", "watch", "find", "ssh", "scp", "sh", "bash", "zsh", "fish", "dash", "osascript", "crontab",
  "at", "batch", "command", "builtin", "noglob", "nocorrect", "coproc", "arch", "caffeinate", "stdbuf", "unbuffer", "chroot", "script", "flock",
  "setsid", "taskset", "chrt", "open", "xdg-open", "busybox", "toybox", "sandbox-exec", "firejail", "parallel", "watchexec", "entr",
  "hyperfine", "strace", "ltrace", "dtruss", "gdb", "lldb", "valgrind", "perf", "awk", "gawk", "mawk", "nawk",
  "if", "then", "else", "elif", "fi", "for", "while", "until", "do", "done", "case", "esac", "function", "select",
]);
/** Tools whose second word is the subcommand: with a flag there instead (`git -C dir push`), only exactly. */
const SUBCOMMANDS = new Set([
  "git", "gh", "npm", "pnpm", "yarn", "bun", "bunx", "npx", "cargo", "go", "docker", "kubectl", "brew", "pip", "pip3", "uv",
  "poetry", "apt", "apt-get", "defaults", "xcodebuild", "swift", "dotnet", "terraform", "aws", "gcloud", "az", "heroku", "vercel",
]);
/** Interpreters: a script by name is a prefix (`python manage.py`), code given inline (`-c`, `-e`) is exact. */
const INTERPRETERS = new Set(["python", "python3", "pypy", "pypy3", "node", "nodejs", "deno", "perl", "ruby", "php", "lua", "luajit", "Rscript", "julia", "pwsh", "powershell"]);
/** Package managers whose `run`/`exec` runs a script named next: the script is part of the prefix (`npm run build`). */
const RUNNERS = new Set(["npm", "pnpm", "yarn", "bun", "uv", "poetry", "pipenv", "hatch", "pdm"]);

/** An interpreter, by any name it goes by (`python3.12`, `node20`). */
const interpreter = (name: string) => INTERPRETERS.has(name) || INTERPRETERS.has(name.replace(/[\d.]+$/, ""));
/** A program a prefix can't stand for: what follows it runs as another command, or as code. */
const runsOthers = (name: string) => EXACT_ONLY.has(name) || /^mkfs\b/.test(name) || interpreter(name);

function bashRules(command: string): AlwaysAllow | null {
  if (!command) return null;
  // Claude Code reads a * in a rule as "anything here", and a rule ending in :* as a prefix: a command with a * can't
  // be allowed exactly, only once.
  const exact = (): AlwaysAllow | null => (command.includes("*") ? null : { rules: [{ toolName: "Bash", ruleContent: command }], label: "Always allow this exact command" });
  // Nested commands, here-documents and line breaks can hide another command: only this one, as it is.
  if (/\$\(|`|<\(|>\(|<<|[\n\r]/.test(command)) return exact();
  // Redirections that change nothing don't count; any other output redirection writes somewhere, so the command is
  // allowed only exactly (shellWords).
  const plain = harmlessRedirectsGone(command);
  // Claude Code checks each part of a compound command on its own: each gets its rule. A part that's only allowed
  // exactly (say, a pipe into sh) keeps the whole command exact, so no part can pass with another command later.
  const parts = splitCommand(plain);
  if (!parts || !parts.length || parts.length > 4) return exact();
  const prefixes: string[] = [];
  for (const part of parts) {
    const p = commandPrefix(part);
    if (p === null) return exact();
    if (!prefixes.includes(p)) prefixes.push(p);
  }
  const list = prefixes.map((p) => `\`${p}\``);
  const named = list.length === 1 ? list[0] : `${list.slice(0, -1).join(", ")} and ${list[list.length - 1]}`;
  return { rules: prefixes.map((p) => ({ toolName: "Bash", ruleContent: `${p}:*` })), label: `Always allow ${named} commands` };
}

/**
 * Whether a shell command is covered by what "Always allow" kept, as ruleContent of alwaysAllow's Bash rules: the very
 * command, or a prefix for every part of it (`git status:*`). The same reading as bashRules': a part that's only allowed
 * exactly, or anything that can hide another command, is covered by nothing but its exact command. For an agent whose
 * approvals the hub enforces itself (Claude Code checks its own rules).
 */
export function commandCovered(command: string, allowed: readonly string[]): boolean {
  const c = command.trim();
  if (!c) return false;
  if (allowed.includes(c)) return true;
  if (/\$\(|`|<\(|>\(|<<|[\n\r]/.test(c)) return false;
  const parts = splitCommand(harmlessRedirectsGone(c));
  if (!parts?.length) return false;
  return parts.every((part) => {
    const p = commandPrefix(part);
    return p !== null && allowed.some((a) => a.endsWith(":*") && (p === a.slice(0, -2) || p.startsWith(`${a.slice(0, -2)} `)));
  });
}

/** Redirections that change nothing (errors into the output, output thrown away) taken out: any other one writes somewhere. */
export function harmlessRedirectsGone(command: string): string {
  return command.replace(/(^|\s)\d?>&\d(?=$|[\s|;&])/g, "$1").replace(/(^|\s)\d?>\s*\/dev\/null(?=$|[\s|;&])/g, "$1");
}

/** A simple command's prefix for a rule: its program and, when it names one, the subcommand ("git status"); null: exact only. */
export function commandPrefix(part: string): string | null {
  const words = shellWords(part);
  if (!words) return null;
  // Leading VAR=value settings change what runs: only exactly.
  if (words.length && /^[A-Za-z_]\w*=/.test(words[0])) return null;
  const [program, second, third] = words;
  if (!program || !/^[\w./+@-]+$/.test(program)) return null;
  const name = basename(program);
  if (EXACT_ONLY.has(name) || /^mkfs\b/.test(name)) return null;
  const word = (w: string | undefined) => !!w && /^[A-Za-z][\w.:+-]*$/.test(w);
  if (interpreter(name)) {
    if (second === "-m" && word(third)) return `${program} -m ${third}`;
    // Deno runs code given inline with `eval`.
    if (name.startsWith("deno") && (second === "eval" || second === "repl")) return null;
    // A script it runs by name: `python manage.py`. Code given inline (-c, -e, …) is only allowed exactly.
    return second && /^[\w./-]+$/.test(second) && !second.startsWith("-") ? `${program} ${second}` : null;
  }
  if (RUNNERS.has(name) && (second === "run" || second === "run-script" || second === "exec" || second === "x" || second === "dlx")) {
    // `npm run build` names a script. `uv run python …`, `npm exec sh …` or `poetry run ./x` runs whatever comes next:
    // only exactly.
    return word(third) && !runsOthers(basename(third!)) ? `${program} ${second} ${third}` : null;
  }
  if (word(second)) return SUBCOMMANDS.has(name) && runsOthers(second!) ? null : `${program} ${second}`;
  return second !== undefined && SUBCOMMANDS.has(name) ? null : program;
}

/** A command split at &&, ||, ;, | and & (outside quotes), trimmed; null when its quotes don't close. */
function splitCommand(command: string): string[] | null {
  const parts: string[] = [];
  let cur = "";
  let quote: string | null = null;
  for (let i = 0; i < command.length; i++) {
    const c = command[i];
    // `${…}`, `$'…'`, `$"…"`, `$[…]` have quoting and code of their own that this reading can't follow. A plain `${NAME}` is
    // only a name, and a `$` before a space only a `$`.
    if (c === "$" && quote !== "'" && !/^\{\w+\}/.test(command.slice(i + 1)) && (quote ? /[{[(]/ : /[^\w?\s]/).test(command[i + 1] ?? "")) return null;
    if (quote) {
      if (c === "\\" && quote === '"' && i + 1 < command.length) cur += c + command[++i];
      else {
        if (c === quote) quote = null;
        cur += c;
      }
      continue;
    }
    if (c === "'" || c === '"') {
      quote = c;
      cur += c;
    } else if (c === "\\" && i + 1 < command.length) cur += c + command[++i];
    else if (c === ";" || c === "|" || c === "&") {
      if (cur.trim()) parts.push(cur.trim());
      cur = "";
      if (command[i + 1] === c) i++;
    } else cur += c;
  }
  if (quote) return null;
  if (cur.trim()) parts.push(cur.trim());
  return parts;
}

/** A simple command's words (up to where its input is redirected), quotes removed; null when it redirects its output or its quoting can't be read. */
function shellWords(part: string): string[] | null {
  const words: string[] = [];
  let cur = "";
  let has = false;
  let quote: string | null = null;
  for (let i = 0; i < part.length; i++) {
    const c = part[i];
    if (quote) {
      if (c === quote) quote = null;
      else if (c === "\\" && quote === '"' && i + 1 < part.length) cur += part[++i];
      else cur += c;
      continue;
    }
    if (c === "'" || c === '"') {
      quote = c;
      has = true;
    } else if (c === "\\" && i + 1 < part.length) {
      cur += part[++i];
      has = true;
    } else if (/\s/.test(c)) {
      if (has || cur) words.push(cur);
      cur = "";
      has = false;
    } else if (c === ">" || c === "(" || c === ")") return null; // it writes somewhere, or runs something (zsh's =(…) and *(e:…:), a function)
    else if (c === "<") return words.length && shellWords(part.slice(i + 1)) ? words : null; // what follows is where its input comes from, read by the same rules
    else {
      cur += c;
      has = true;
    }
  }
  if (quote) return null;
  if (has || cur) words.push(cur);
  return words;
}

function absolute(p: string, cwd: string): string | null {
  if (!p) return null;
  if (p.startsWith("~/")) return null; // the home folder isn't known here
  return isAbsolute(p) ? resolve(p) : resolve(cwd, p);
}

/** A path as a rule's pattern: characters that mean something in a pattern are escaped. */
function globSafe(path: string): string {
  return path.replace(/[\\*?[\]{}!#]/g, (c) => `\\${c}`);
}

