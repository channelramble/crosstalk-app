// What a service that holds to OpenAI's message rules, with a strict JSON parser, says of a request Crosstalk's agent sends.
// The stand-ins answer whatever they get, so this goes in front of one as the driver's fetch, and refuses in the service's
// own words what a real one would. The rules are OpenAI's documented ones and serde_json's refusal of half an emoji; no
// real service was asked.

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = any;

/** Why the service would refuse this request's body, or null when it wouldn't. */
export function refusalOf(body: string): string | null {
  let halfEmoji = false;
  const asked = JSON.parse(body) as Json;
  JSON.stringify(asked, (_key, value) => {
    if (typeof value === "string" && /\p{Cs}/u.test(value)) halfEmoji = true;
    return value;
  });
  if (halfEmoji) return "lone leading surrogate in hex escape at line 1 column 4641";
  const messages: Json[] = asked.messages ?? [];
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i];
    if (m.role === "assistant" && m.tool_calls?.length) {
      const open = new Set(m.tool_calls.map((c: Json) => c.id));
      for (let j = i + 1; j < messages.length && messages[j].role === "tool"; j++) open.delete(messages[j].tool_call_id);
      if (open.size) return `An assistant message with 'tool_calls' must be followed by tool messages responding to each 'tool_call_id'. The following tool_call_ids did not have response messages: ${[...open].join(", ")}`;
      for (const c of m.tool_calls) {
        let args: unknown;
        try {
          args = JSON.parse(c.function.arguments);
        } catch {
          return "Assistant tool call function.arguments must be valid JSON.";
        }
        if (!args || typeof args !== "object" || Array.isArray(args)) return "Assistant tool call function.arguments must be a JSON object.";
      }
    }
    if (m.role === "tool") {
      let k = i - 1;
      while (k >= 0 && messages[k].role === "tool") k--;
      if (k < 0 || !messages[k].tool_calls?.some((c: Json) => c.id === m.tool_call_id)) return "Messages with role 'tool' must be a response to a preceding message with 'tool_calls'.";
    }
  }
  return null;
}

/** A fetch that answers a request the service would refuse with its 400, and passes on anything else (a fetch_url's too). */
export function strictFetch(next: typeof fetch = fetch) {
  const refused: string[] = [];
  const get = (async (url: string, init?: RequestInit) => {
    const bad = typeof init?.body === "string" ? refusalOf(init.body) : null;
    if (bad) {
      refused.push(bad);
      return Response.json({ error: { message: bad, type: "invalid_request_error" } }, { status: 400 });
    }
    return next(url, init);
  }) as unknown as typeof fetch;
  return { get, refused };
}
