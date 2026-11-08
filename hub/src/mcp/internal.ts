import { PROVIDER_INFO, type AgentQuestion } from "@crosstalk/shared";
import type { App } from "../app";
import { askHelper } from "../teamwork";
import { describeToolCall } from "./describe";
import { alwaysAllow, ruleText } from "./always";

const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } });

/**
 * Endpoints for the per-agent MCP helper processes (`crosstalk-hub mcp`), served on the hub's Unix socket only
 * (internal-server.ts). Each call says which member it's for and carries that member's own key, handed to its
 * helper through the env: the member is never taken from the request body.
 */
export async function handleInternal(app: App, req: Request, url: URL): Promise<Response> {
  const memberId = req.headers.get("x-crosstalk-member") ?? "";
  if (!memberId || !app.checkInternalToken(memberId, req.headers.get("x-crosstalk-token") ?? "")) return json({ error: "forbidden" }, 403);
  const body = req.method === "POST" ? ((await req.json().catch(() => ({}))) as Record<string, any>) : {}; // eslint-disable-line @typescript-eslint/no-explicit-any
  const member = app.store.getMember(memberId);
  if (!member) return json({ error: "unknown member" }, 404);
  const room = app.store.getRoom(member.roomId)!;

  switch (url.pathname) {
    case "/internal/members": {
      const members = app.store.listMembers(room.id);
      return json({
        room: { name: room.name, cwd: room.cwd, mode: room.mode, maxHops: room.maxHops },
        you: member.handle,
        members: members.map((m) => ({
          handle: m.handle,
          agent: PROVIDER_INFO[m.provider].name,
          role: m.role,
          status: m.status,
          lead: room.leadMemberId === m.id,
        })),
      });
    }
    case "/internal/read": {
      const limit = Math.min(Number(body.limit ?? url.searchParams.get("limit") ?? 20), 100);
      const msgs = app.store.listMessages(room.id, { limit });
      const members = app.store.listMembers(room.id);
      return json({
        messages: msgs.map((m) => ({
          from: m.authorKind === "human" ? `human (${m.authorName})` : m.authorKind === "system" ? "crosstalk" : `@${members.find((x) => x.id === m.memberId)?.handle ?? m.authorName}`,
          text: m.text,
          at: new Date(m.createdAt).toISOString(),
        })),
      });
    }
    case "/internal/post": {
      const text = String(body.text ?? "").trim();
      if (!text) return json({ error: "empty" }, 400);
      const m = app.engine.agentPost(member.id, text);
      return json({ ok: !!m });
    }
    case "/internal/approve": {
      // Claude Code's --permission-prompt-tool contract: input { tool_name, input, tool_use_id? }
      const toolName = String(body.tool_name ?? "tool");
      const input = (body.input ?? {}) as Record<string, unknown>;
      if (toolName === "AskUserQuestion" && Array.isArray(input.questions)) {
        // Not a permission: questions for the human. The answers go back in the tool's input (question text -> answer).
        const raw = input.questions as Record<string, unknown>[];
        const questions: AgentQuestion[] = raw.map((q, i) => ({
          id: String(i),
          header: String(q.header ?? ""),
          question: String(q.question ?? ""),
          options: Array.isArray(q.options) ? (q.options as Record<string, unknown>[]).map((o) => ({ label: String(o.label ?? ""), description: String(o.description ?? "") })) : [],
          multiSelect: q.multiSelect === true,
          allowOther: true,
        }));
        const title = questions.length === 1 ? questions[0].header || questions[0].question : `${questions.length} questions`;
        const answers = await app.engine.askFromAgent(member.id, title.slice(0, 200), questions);
        if (!answers) return json({ behavior: "deny", message: "The human skipped these questions in Crosstalk. Carry on with your best judgment, or ask again in your reply." });
        const byText: Record<string, string> = {};
        for (const q of questions) if (answers[q.id]?.length) byText[q.question] = answers[q.id].join(", ");
        return json({ behavior: "allow", updatedInput: { ...input, answers: byText } });
      }
      const d = describeToolCall(toolName, input);
      // "Always allow" allows what its button says (that command's first word or two, that file, that site), never
      // every use of the tool.
      const always = alwaysAllow(toolName, input, room.cwd);
      const decision = await app.engine.approvalFromAgent(member.id, { ...d, always: always?.label ?? null });
      if (decision === "deny") return json({ behavior: "deny", message: "The human denied this in Crosstalk." });
      const out: Record<string, unknown> = { behavior: "allow", updatedInput: input };
      if (decision === "approve_always" && always) {
        out.updatedPermissions = [{ type: "addRules", rules: always.rules, behavior: "allow", destination: "session" }];
        // Claude Code keeps them for this process; Crosstalk gives them to the next one too (it's restarted when idle).
        const s = app.store.getMemberSession(member.id);
        const kept = Array.isArray(s.allowRules) ? (s.allowRules as unknown[]).filter((r): r is string => typeof r === "string") : [];
        app.store.setMemberSession(member.id, { ...s, allowRules: [...new Set([...kept, ...always.rules.map(ruleText)])].slice(-100) });
      }
      return json(out);
    }
    case "/internal/xchat/list":
    case "/internal/xchat/read":
    case "/internal/xchat/send":
    case "/internal/xchat/wait":
    case "/internal/xchat/start": {
      // The user's other chats (xchat.ts). Checked again here: the setting may have changed since the agent started.
      if (!app.xchat.offered(room, member)) return json({ text: app.xchat.offText() });
      const signal = req.signal;
      try {
        const kind = url.pathname.slice("/internal/xchat/".length);
        const text =
          kind === "list"
            ? await app.xchat.toolList(member, body)
            : kind === "read"
              ? await app.xchat.toolRead(member, body as { chat: string })
              : kind === "send"
                ? await app.xchat.toolSend(member, body as { chat: string; text: string }, signal)
                : kind === "wait"
                  ? await app.xchat.toolWait(member, body as { message_id: string }, signal)
                  : await app.xchat.toolStart(member, body as { agent: string; title: string; text: string }, signal);
        return json({ text });
      } catch (e) {
        return json({ text: e instanceof Error ? e.message : String(e), error: true });
      }
    }
    case "/internal/helper_model": {
      // The user asked in the chat for helper agents on another model (model-lock.ts).
      try {
        return json({ text: await app.useHelperModel(member.id, String(body.model ?? "")) });
      } catch (e) {
        return json({ text: e instanceof Error ? e.message : String(e), error: true });
      }
    }
    case "/internal/ask": {
      // Teamwork: a chat's agent asks the other agent one question (limits and plan checks in askHelper).
      const question = String(body.question ?? "").trim();
      if (!question) return json({ error: "Write the question to ask." }, 400);
      return json({ answer: await askHelper(app, member.id, question.slice(0, 8000)) });
    }
  }
  return json({ error: "not found" }, 404);
}
