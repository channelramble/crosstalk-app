import { PROVIDER_INFO, type ApprovalKind } from "@crosstalk/shared";

/** Turn a tool call into a readable approval card. */
export function describeToolCall(toolName: string, input: Record<string, unknown>): { kind: ApprovalKind; title: string; detail: string } {
  const s = (v: unknown) => (typeof v === "string" ? v : JSON.stringify(v, null, 2));
  switch (toolName) {
    case "Bash":
      return { kind: "command", title: oneLine(s(input.command ?? "")), detail: [input.description ? `# ${s(input.description)}` : "", s(input.command ?? "")].filter(Boolean).join("\n") };
    case "Write":
      return { kind: "file_change", title: `Write ${s(input.file_path ?? "a file")}`, detail: truncate(s(input.content ?? ""), 8000) };
    case "Edit":
    case "MultiEdit": {
      const path = s(input.file_path ?? "a file");
      const edits = Array.isArray(input.edits) ? input.edits : [{ old_string: input.old_string, new_string: input.new_string }];
      const diff = edits
        .map((e: Record<string, unknown>) => {
          const minus = String(e.old_string ?? "").split("\n").map((l) => `- ${l}`).join("\n");
          const plus = String(e.new_string ?? "").split("\n").map((l) => `+ ${l}`).join("\n");
          return `${minus}\n${plus}`;
        })
        .join("\n…\n");
      return { kind: "file_change", title: `Edit ${path}`, detail: truncate(diff, 8000) };
    }
    case "NotebookEdit":
      return { kind: "file_change", title: `Edit notebook ${s(input.notebook_path ?? "")}`, detail: truncate(s(input.new_source ?? ""), 4000) };
    case "WebFetch":
      return { kind: "tool", title: `Fetch ${s(input.url ?? "a web page")}`, detail: s(input.prompt ?? "") };
    case "WebSearch":
      return { kind: "tool", title: `Search the web: ${s(input.query ?? "")}`, detail: "" };
    case "ToolSearch":
      return { kind: "tool", title: "Looked up tools", detail: s(input.query ?? "") };
    default: {
      const chats = chatToolTitle(toolName.replace(/^mcp__crosstalk__/, ""), input);
      if (chats) return { kind: "tool", title: chats, detail: s(input.text ?? input.query ?? "") };
      const asked = /^mcp__crosstalk__ask_(\w+)$/.exec(toolName)?.[1];
      const name = asked ? (PROVIDER_INFO as Record<string, { name: string }>)[asked]?.name : undefined;
      if (name) return { kind: "tool", title: `Asked ${name}: ${oneLine(s(input.question ?? ""), 120)}`, detail: s(input.question ?? "") };
      return { kind: "tool", title: `Use ${toolName}`, detail: truncate(JSON.stringify(input, null, 2), 6000) };
    }
  }
}

/** What an agent did with the user's other chats, in words (xchat.ts tools); null for any other tool. */
export function chatToolTitle(tool: string, input: Record<string, unknown>): string | null {
  const str = (v: unknown) => (typeof v === "string" ? v : "");
  const where = `"${oneLine(str(input.chat), 60)}"${str(input.machine) ? ` (${oneLine(str(input.machine), 40)})` : ""}`;
  switch (tool) {
    case "list_chats":
      return `Listed chats${str(input.query) ? `: ${oneLine(str(input.query), 60)}` : ""}${str(input.machine) ? ` on ${oneLine(str(input.machine), 40)}` : ""}`;
    case "read_chat":
      return `Read ${where}`;
    case "send_to_chat":
      return `Messaged ${where}: ${oneLine(str(input.text), 100)}`;
    case "wait_for_reply":
      return "Waited for a reply from another chat";
    case "start_chat":
      return `Started a ${str(input.agent) === "codex" ? "Codex" : "Claude Code"} chat "${oneLine(str(input.title), 60)}"${str(input.machine) ? ` on ${oneLine(str(input.machine), 40)}` : ""}`;
  }
  return null;
}

export function oneLine(s: string, max = 160): string {
  const t = s.replace(/\s+/g, " ").trim();
  return t.length > max ? t.slice(0, max - 1) + "…" : t;
}

function truncate(s: string, max: number): string {
  return s.length > max ? s.slice(0, max) + "\n…(truncated)" : s;
}
