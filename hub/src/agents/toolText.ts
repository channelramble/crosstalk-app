// A model that writes a tool call out as text instead of making one. DeepSeek V4.1 Flash does it late in long, tool-heavy
// sessions (`<｜DSML｜tool_calls>`, OpenCode issue #50206; GLM has its own forms, #56352), and to an agent loop an answer with
// no tool call in it means "finished": nothing runs, and a long batch of work ends there, looking done. Neither Crosstalk's
// own agent nor OpenCode can tell on its own, so what they answered is looked at here, and the model is asked to make the
// call properly.
//
// What counts: DeepSeek's DSML and its special tool-call tokens anywhere outside a code block (nobody writes those in prose
// by accident), and the plainer forms (`<tool_call>`, `<function=x>`, `<invoke name="x">`, `<function_calls>`) only when they
// start a line in the last part of the answer. A code block doesn't count, nor does mention of a tag in a sentence: an
// answer about a tool-call parser is an answer.

/** Unmistakable tokens: only a model's tool-call channel spilling over writes these. */
const TOKENS = /<\s*[|｜]\s*\/?\s*DSML\s*[|｜]|<\/\s*[|｜]\s*DSML\s*[|｜]|<\s*[|｜]\s*tool[▁_]calls?[▁_](?:begin|sep|end)\s*[|｜]\s*>/i;
/** The plainer forms, at the start of a line. */
const TAGS = /^[ \t]*<(?:(?:tool_call|function_calls|tool_calls)\b|function=[\w.-]+|invoke\s+name=)[^\n]*$/im;
/** How far from the end a plain tag still counts: a leak ends the answer, it isn't quoted in the middle of one. */
const TAG_TAIL = 3000;

/** The text with its fenced code blocks blanked out (kept the same length, so positions still line up). */
function outsideCode(text: string): string {
  // Inline code is filled with something other than spaces: "`x` <tool_call>" mustn't come to look like a tag starting its line.
  return text.replace(/^[ \t]*(```|~~~)[^\n]*\n[\s\S]*?(?:^[ \t]*\1[ \t]*$|$(?![\s\S]))/gm, (block) => " ".repeat(block.length)).replace(/(`+)[^\n]*?\1/g, (span) => "_".repeat(span.length));
}

/** Where a tool call written as text starts in an answer, or -1 when there is none. */
export function textToolCallAt(text: string): number {
  if (!text.includes("<")) return -1;
  const open = outsideCode(text);
  const token = open.search(TOKENS);
  if (token >= 0) return token;
  const from = Math.max(0, open.length - TAG_TAIL);
  const tag = open.slice(from).search(TAGS);
  return tag >= 0 ? from + tag : -1;
}

/** The answer as it reads without the tool call it wrote out (the leak runs to the end of it). */
export function withoutTextToolCall(text: string): string {
  const at = textToolCallAt(text);
  return at < 0 ? text : text.slice(0, at).trimEnd();
}

/** What the model is told when it did that. */
export const TEXT_TOOL_CALL_NUDGE =
  "Your last message wrote a tool call out as text, so it did not run and nothing happened. Make the call again as a real tool call, not as text in your answer, and carry on with the task.";

/** What the reply ends with when the model goes on doing that after being asked again. */
export const TEXT_TOOL_CALL_GAVE_UP =
  "The model kept writing its commands out as text instead of running them, so nothing more ran and the work isn't finished. Send a message to let it carry on, or pick another model in this chat's settings.";

/** What the model is told after an answer with nothing in it: to an agent loop that is "finished", which it rarely means. */
export const EMPTY_ANSWER_NUDGE = "Your last message was empty. Carry on with the task; if it is finished, say what you did and how you checked it.";

/** What the model is told when it keeps making the very same call. */
export const repeatNudge = (times: number) =>
  `You have made exactly the same tool call ${times} times in a row, so it was stopped. It isn't getting you anywhere: try another way, or stop and say what is in the way.`;
