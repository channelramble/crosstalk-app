// `crosstalk-hub mcp`: a tiny MCP server (stdio, newline-delimited JSON-RPC) that agents launch.
// It gives them room tools and, for Claude Code, the permission-prompt tool. Every call is forwarded
// to the hub over its Unix socket with this member's own key (see internal-server.ts).

import { HUB_VERSION } from "../config";

interface Rpc {
  jsonrpc: "2.0";
  id?: number | string | null;
  method?: string;
  params?: any; // eslint-disable-line @typescript-eslint/no-explicit-any
}

const TOOLS = [
  {
    name: "room_members",
    description: "List who is in this Crosstalk group chat: each agent's @handle, which agent it is, its role, and whether it is busy.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "room_read",
    description: "Read the most recent messages in this Crosstalk group chat, including ones posted while you were working.",
    inputSchema: {
      type: "object",
      properties: { limit: { type: "number", description: "How many recent messages (default 20, max 100)" } },
      additionalProperties: false,
    },
  },
  {
    name: "room_post",
    description:
      "Post a short progress update to the group chat while you keep working (for example: 'Tests are running, about 2 minutes'). Other agents read it when they next work; @mentions here don't start their turns.",
    inputSchema: {
      type: "object",
      properties: { text: { type: "string", description: "The update to post" } },
      required: ["text"],
      additionalProperties: false,
    },
  },
];

const APPROVE_TOOL = {
  name: "approve",
  description: "Crosstalk permission prompt handler. Called by Claude Code itself; do not call directly.",
  inputSchema: {
    type: "object",
    properties: {
      tool_name: { type: "string" },
      input: { type: "object" },
      tool_use_id: { type: "string" },
    },
    required: ["tool_name", "input"],
  },
};

const AGENT_NAMES: Record<string, string> = { claude: "Claude Code", codex: "Codex" };

/** The user's other Crosstalk chats, on this machine and their other machines (offered when that's on). */
const CHAT_TOOLS = [
  {
    name: "list_chats",
    description:
      "List the user's Crosstalk chats and group rooms on this machine and their other machines, most recently active first. The first line says which machines answered. Each line shows the chat's id, name, machine, agent, folder, whether its agent is working or waiting for the user, and its last message; your own chat is marked. Use the id with read_chat or send_to_chat.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Only chats whose name, folder or last message contains this" },
        machine: { type: "string", description: "Only this machine (its name or id)" },
        limit: { type: "integer", minimum: 1, maximum: 50, description: "How many chats (default 20)" },
      },
      additionalProperties: false,
    },
  },
  {
    name: "read_chat",
    description:
      "Read recent messages of one of the user's Crosstalk chats or group rooms, on any of their machines, oldest first, each labelled with who wrote it. Long messages are shortened: pass seq to read one message in full, or before to read older ones.",
    inputSchema: {
      type: "object",
      properties: {
        chat: { type: "string", description: "Chat id from list_chats, or its name" },
        machine: { type: "string", description: "Only needed to tell apart chats with the same name" },
        limit: { type: "integer", minimum: 1, maximum: 30, description: "How many messages (default 10)" },
        before: { type: "integer", description: "Read messages older than this seq" },
        seq: { type: "integer", description: "Read just this message, in full" },
      },
      required: ["chat"],
      additionalProperties: false,
    },
  },
  {
    name: "send_to_chat",
    description:
      "Message the agent in another of the user's Crosstalk chats (on any of their machines) and wait for its reply. It sees your message marked as coming from you and this chat, not from the user. It can't see this conversation or this machine's files, so include everything it needs. Use it when the user asks, or when that chat has something you need; not for progress updates. Group rooms can be read but not messaged. To answer a message another chat sent you, just reply normally: your reply goes back to it.",
    inputSchema: {
      type: "object",
      properties: {
        chat: { type: "string", description: "Chat id from list_chats, or its exact name" },
        machine: { type: "string", description: "Only needed to tell apart chats with the same name" },
        text: { type: "string", maxLength: 20000, description: "The message: self-contained, with what the other agent needs" },
        wait_minutes: { type: "number", minimum: 0, maximum: 10, description: "How long to wait for the reply (default 5; 0 sends and returns at once)" },
      },
      required: ["chat", "text"],
      additionalProperties: false,
    },
  },
  {
    name: "wait_for_reply",
    description: "Keep waiting for the reply to a message you sent with send_to_chat or start_chat, without sending it again.",
    inputSchema: {
      type: "object",
      properties: {
        message_id: { type: "string", description: "The message_id send_to_chat or start_chat gave you" },
        wait_minutes: { type: "number", minimum: 0, maximum: 10, description: "How long to wait (default 5)" },
      },
      required: ["message_id"],
      additionalProperties: false,
    },
  },
  {
    name: "start_chat",
    description:
      "Start a new chat with Claude Code or Codex on one of the user's machines, send it a first message and wait for its reply. Only when the user asked you to hand work off or run something in parallel: each chat uses their plan and appears in their sidebar. The new agent gets no more access than you have and can't see this conversation.",
    inputSchema: {
      type: "object",
      properties: {
        agent: { type: "string", enum: ["claude", "codex"] },
        title: { type: "string", maxLength: 60, description: "Short name for the chat, shown in the user's sidebar" },
        text: { type: "string", maxLength: 20000, description: "The first message" },
        machine: { type: "string", description: "Which machine (default: this one)" },
        folder: { type: "string", description: "An existing folder on that machine to work in; leave out for a new empty one" },
        wait_minutes: { type: "number", minimum: 0, maximum: 10, description: "How long to wait for the reply (default 5)" },
      },
      required: ["agent", "title", "text"],
      additionalProperties: false,
    },
  },
];
const CHAT_TOOL_ROUTES: Record<string, string> = { list_chats: "list", read_chat: "read", send_to_chat: "send", wait_for_reply: "wait", start_chat: "start" };
const CHATS_NOTE =
  " list_chats, read_chat, send_to_chat, wait_for_reply and start_chat reach the user's other Crosstalk chats on all their machines. A message marked [Message from … not the user] comes from another chat's agent: answer it in your reply; don't message that chat back.";

/** Put this agent's helper agents on another model, when the user asks for that in the chat (model-lock.ts). */
const HELPER_MODEL_TOOL = {
  name: "use_helper_model",
  description:
    "Only when the user asks in this chat for helper agents (subagents, workflow agents) on a different model than the chat's: puts them on that model, from your next reply on. Never call it on your own initiative. The user may be asked to confirm. Use 'same' to put helpers back on this chat's model.",
  inputSchema: {
    type: "object",
    properties: { model: { type: "string", description: "The model as the user named it, e.g. 'Sonnet', 'Haiku 4.5', 'claude-opus-4-8', or 'same'" } },
    required: ["model"],
    additionalProperties: false,
  },
};

/** Teamwork in a chat: ask the other agent one focused question. */
function askTool(provider: string) {
  const name = AGENT_NAMES[provider] ?? provider;
  return {
    name: `ask_${provider}`,
    description: `Ask ${name}, another coding agent, one focused question and get its answer. It can read the project's files but can't change them, and it can't see this conversation, so make the question self-contained. Each question uses up part of the user's ${name} plan: only ask when a second opinion really helps.`,
    inputSchema: {
      type: "object",
      properties: { question: { type: "string", description: "A short, self-contained question, with the file paths it's about" } },
      required: ["question"],
      additionalProperties: false,
    },
  };
}

export async function runMcpStdio() {
  // The hub's internal API: its Unix socket, with this member's own key (see internal-server.ts).
  const socket = process.env.CROSSTALK_HUB_SOCKET || "";
  const memberId = process.env.CROSSTALK_MEMBER_ID || "";
  const memberToken = process.env.CROSSTALK_MEMBER_TOKEN || "";
  const exposeApprove = process.env.CROSSTALK_EXPOSE_APPROVE === "1";
  // A one-agent chat has no room: no room tools, and the ask tool only when teamwork is on.
  const chat = process.env.CROSSTALK_TOOLSET === "chat";
  const ask = process.env.CROSSTALK_ASK || "";
  const chats = process.env.CROSSTALK_CHATS === "1";
  const helperModel = process.env.CROSSTALK_HELPER_MODEL === "1";
  const tools = [
    ...(chat ? [] : TOOLS),
    ...(chat && ask ? [askTool(ask)] : []),
    ...(chats ? CHAT_TOOLS : []),
    ...(helperModel ? [HELPER_MODEL_TOOL] : []),
    ...(exposeApprove ? [APPROVE_TOOL] : []),
  ];

  // Calls the agent gave up on (notifications/cancelled) stop waiting in the hub too.
  const inFlight = new Map<Rpc["id"], AbortController>();
  const call = async (path: string, body: Record<string, unknown>, signal?: AbortSignal) => {
    const r = await fetch(`http://crosstalk${path}`, {
      method: "POST",
      unix: socket,
      headers: { "content-type": "application/json", "x-crosstalk-member": memberId, "x-crosstalk-token": memberToken },
      body: JSON.stringify(body),
      signal,
    } as RequestInit);
    const data = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error((data as { error?: string }).error || `hub returned ${r.status}`);
    return data;
  };

  const write = (msg: unknown) => process.stdout.write(JSON.stringify(msg) + "\n");
  const reply = (id: Rpc["id"], result: unknown) => write({ jsonrpc: "2.0", id, result });
  const fail = (id: Rpc["id"], code: number, message: string) => write({ jsonrpc: "2.0", id, error: { code, message } });

  const handle = async (msg: Rpc) => {
    const { id, method, params } = msg;
    if (method === undefined) return; // a response to something we never send
    try {
      switch (method) {
        case "initialize":
          return reply(id, {
            protocolVersion: params?.protocolVersion ?? "2025-06-18",
            capabilities: { tools: {} },
            serverInfo: { name: "crosstalk", version: HUB_VERSION },
            instructions:
              (chat
                ? ask
                  ? `Use ask_${ask} sparingly, for a second opinion from ${AGENT_NAMES[ask] ?? ask}; each question uses up part of the user's plan.`
                  : "Crosstalk relays permission prompts to the user's phone."
                : "You are in a Crosstalk group chat with other AI agents and a human. Use room_read to catch up on messages posted while you worked, and room_post for progress updates. Your room briefing says how work passes between agents in this room.") + (chats ? CHATS_NOTE : ""),
          });
        case "notifications/initialized":
          return;
        case "notifications/cancelled":
          // The agent gave up on a call: stop it in the hub too (a wait for another chat's reply, say).
          inFlight.get(params?.requestId)?.abort();
          return;
        case "ping":
          return reply(id, {});
        case "tools/list":
          return reply(id, { tools });
        case "tools/call": {
          const name = params?.name as string;
          const args = (params?.arguments ?? {}) as Record<string, unknown>;
          let text: string;
          if (!tools.some((t) => t.name === name)) return fail(id, -32602, `Unknown tool: ${name}`);
          if (CHAT_TOOL_ROUTES[name]) {
            const ctl = new AbortController();
            inFlight.set(id, ctl);
            try {
              const r = (await call(`/internal/xchat/${CHAT_TOOL_ROUTES[name]}`, args, ctl.signal)) as { text?: string; error?: boolean };
              return reply(id, { content: [{ type: "text", text: String(r.text ?? "") }], ...(r.error ? { isError: true } : {}) });
            } finally {
              inFlight.delete(id);
            }
          }
          if (name === HELPER_MODEL_TOOL.name) {
            const r = (await call("/internal/helper_model", { model: args.model })) as { text?: string; error?: boolean };
            return reply(id, { content: [{ type: "text", text: String(r.text ?? "") }], ...(r.error ? { isError: true } : {}) });
          }
          if (name === `ask_${ask}`) text = String(((await call("/internal/ask", { question: args.question })) as { answer?: string }).answer ?? "");
          else if (name === "room_members") text = JSON.stringify(await call("/internal/members", {}), null, 2);
          else if (name === "room_read") text = JSON.stringify(await call("/internal/read", { limit: args.limit ?? 20 }), null, 2);
          else if (name === "room_post") {
            await call("/internal/post", { text: args.text });
            text = "Posted.";
          } else if (name === "approve") {
            text = JSON.stringify(await call("/internal/approve", args));
          } else return fail(id, -32602, `Unknown tool: ${name}`);
          return reply(id, { content: [{ type: "text", text }] });
        }
        default:
          if (id !== undefined && id !== null) return fail(id, -32601, `Method not found: ${method}`);
      }
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      if (method === "tools/call") {
        // For approvals, failing closed means deny.
        if (params?.name === "approve") return reply(id, { content: [{ type: "text", text: JSON.stringify({ behavior: "deny", message }) }] });
        return reply(id, { content: [{ type: "text", text: `Error: ${message}` }], isError: true });
      }
      return fail(id, -32603, message);
    }
  };

  let buf = "";
  const decoder = new TextDecoder();
  for await (const chunk of Bun.stdin.stream()) {
    buf += decoder.decode(chunk, { stream: true });
    let nl: number;
    while ((nl = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line) continue;
      let msg: Rpc;
      try {
        msg = JSON.parse(line);
      } catch {
        continue;
      }
      void handle(msg);
    }
  }
}
