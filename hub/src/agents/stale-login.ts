// Telling a reply that failed because the agent's sign-in stopped working from every other failure, per agent. The
// engine (engine.ts, "A sign-in that stopped working") starts that agent's process again once, so it reads the sign-in
// as it is now, and carries on; a second failure, or an agent found signed out, ends in plain words with a way to sign
// in from the phone (signin.ts).
//
// Like limits.ts, detection leans on the agents' typed signals first (Claude Code's `authentication_failed`, Codex's
// `unauthorized`, Muse's `authRequired`, the agent protocol's -32000 "Authentication required"), and the words only
// sort those into kinds. Never a broad "auth" regex: an API key that's wrong, a full disk ("signing in again won't
// help") or a gateway that refuses aren't a stale sign-in, and restarting the agent for them would only hide the real
// problem. Each lookalike has a test in hub/test/stale-login.test.ts.

/**
 * What a driver reports when the agent's sign-in, not the request, ended the turn.
 * "stale": the sign-in this process holds stopped working (it expired and couldn't be renewed, the server refused it,
 * the agent asked to be started again): a fresh process reads the sign-in as it is now, which another process may have
 * renewed. "busy": another process of the same agent was renewing the shared sign-in at that moment (it says so, and
 * it's usually over within a minute). "signedOut": the agent has no sign-in at all.
 */
export interface AuthHit {
  kind: "stale" | "busy" | "signedOut";
  /** The agent's own words, for the hub's log (the chat gets Crosstalk's). Never a token: agents don't print them here. */
  said: string;
}

const cut = (s: string) => s.replace(/\s+/g, " ").trim().slice(0, 300);

/**
 * Claude Code (checked against 2.1.289 and 2.1.316). A failed sign-in never reaches the API: the client refuses before
 * any request, so the turn costs nothing. Its synthetic assistant message carries the SDK error kind (`error`), and the
 * result its words, `api_error`, `api_error_status` and (2.1.316) `api_error_origin`. The words are the non-interactive
 * ones (`-p`), with the interactive ones too, in case a version prints those.
 * - "Failed to authenticate: OAuth session expired and could not be refreshed" / "Login expired · Please run /login"
 *   (OAuthRefreshDeadError: no usable access token, and the refresh token is empty or was refused): stale.
 * - "Failed to authenticate: OAuth token revoked…" / "OAuth token revoked · Please run /login" (the API said 401 or 403
 *   with "OAuth token has been revoked", and the status comes with it): stale (another process may have signed in again
 *   since).
 * - "Failed to refresh OAuth token: another Claude Code process is refreshing it or exited mid-refresh…" (server_error):
 *   busy.
 * - "Restart Claude Code to finish signing in." (api_error stored_login_refused, 2.1.316): stale; a restart is the fix.
 * - "Not logged in · Please run /login", "Authentication required · Sign in again to continue": signed out.
 * - An answer of the API itself: Claude Code words every 401 and 403 the same way ("Failed to authenticate. API Error:
 *   403 …", `authentication_failed`), a gateway's too. Only a 401 from Anthropic's own API is a sign-in it refused
 *   (stale): 2.1.316 marks those `api_error_origin: "first_party"`, and leaves it out for a gateway or another address;
 *   an older Claude Code doesn't say, so there the body must be Anthropic's own `authentication_error`. A 403 is a
 *   permission the account doesn't have ("This organization has been disabled.", "OAuth token does not meet scope
 *   requirement"): no restart or sign-in changes it, so it's never stale.
 * Not a stale sign-in either: the full-disk refresh failure ("signing in again won't help"), API keys, gateways and cloud
 * providers' credentials, and Claude Code's "Authentication error · This may be a temporary network issue" (a cloud
 * session's).
 *
 * `marksOrigin`: this Claude Code says `api_error_origin` (claudeMarksOrigin), so its absence means the answer wasn't
 * Anthropic's.
 */
export function claudeAuthHit(ev: { error?: unknown; apiError?: unknown; apiErrorStatus?: unknown; apiErrorOrigin?: unknown; marksOrigin?: boolean; text?: string | null }): AuthHit | null {
  const text = String(ev.text ?? "");
  const said = cut(text);
  if (/won't help|won't change this|disk that holds the Claude Code config/i.test(text)) return null;
  if (ev.apiError === "provider_credentials" || ev.apiError === "api_key_auth_disabled" || ev.apiError === "invalid_credential_header" || ev.apiError === "org_disabled_credential") return null;
  if (/invalid api key|x-api-key|ANTHROPIC_API_KEY|apiKeyHelper|external auth token|ANTHROPIC_CUSTOM_HEADERS/i.test(text)) return null;
  if (ev.apiError === "stored_login_refused") return /restart Claude Code/i.test(text) ? { kind: "stale", said } : null;
  if (/another Claude Code process is refreshing it/i.test(text)) return { kind: "busy", said };
  const typed = ev.error === "authentication_failed" || ev.apiErrorStatus === 401;
  if (!typed) return null;
  // Claude Code's own sentences about the sign-in it holds, as they start (never words inside an API's answer). It
  // words a revoked token this way whether the API said 401 or 403, and gives the status with it.
  const own = text.trim();
  if (/^(?:Not logged in|Authentication required)\b/i.test(own)) return { kind: "signedOut", said };
  if (/^(?:Failed to authenticate: )?(?:OAuth session expired|OAuth token revoked)\b|^Login expired\b/i.test(own)) return { kind: "stale", said };
  // Any other answer of the API's: only Anthropic's own 401.
  const status = typeof ev.apiErrorStatus === "number" ? ev.apiErrorStatus : Number(/\bAPI Error: (\d{3})\b/.exec(text)?.[1] ?? 0) || null;
  if (status !== 401) return null;
  const anthropics = ev.apiErrorOrigin === "first_party" || (ev.apiErrorOrigin == null && !ev.marksOrigin && /"type"\s*:\s*"authentication_error"/.test(text));
  return anthropics ? { kind: "stale", said } : null;
}

/** Whether a Claude Code version marks the API's own answers (`api_error_origin`, 2.1.316 on). Unknown: no. */
export function claudeMarksOrigin(version: string | null | undefined): boolean {
  const v = /^(\d+)\.(\d+)\.(\d+)/.exec(String(version ?? "").trim());
  if (!v) return false;
  const [a, b, c] = v.slice(1).map(Number);
  return a !== 2 ? a > 2 : b !== 1 ? b > 1 : c >= 316;
}

/**
 * Codex (0.160). A TurnError's typed `codexErrorInfo` "unauthorized" is the signal; its message says which ("Your access
 * token could not be refreshed because your refresh token has expired / was already used / was revoked. Please log out
 * and sign in again.", "…because you have since logged out or signed in to another account. Please sign in again.",
 * "Your authentication session could not be refreshed automatically…"). Codex reloads its auth.json before giving up,
 * so a fresh process helps only when the account was switched there; the check that follows says the rest.
 */
export function codexAuthHit(error: { codexErrorInfo?: unknown; message?: unknown } | null | undefined): AuthHit | null {
  if (!error) return null;
  const message = typeof error.message === "string" ? error.message : "";
  const unauthorized = error.codexErrorInfo === "unauthorized";
  const words = /access token could not be refreshed|authentication session could not be refreshed|refresh token (?:has expired|was already used|was revoked)/i.test(message);
  if (!unauthorized && !words) return null;
  if (/not (?:logged|signed) in\b/i.test(message) && !words) return { kind: "signedOut", said: cut(message) };
  return { kind: "stale", said: cut(message || "unauthorized") };
}

/**
 * Muse Code (1.4.14). Its session protocol ends a turn with error kind "authRequired": "not logged in: run `muse login`
 * first" (signed out) or "still unauthorized after a token refresh; run `muse login` again" (stale).
 */
export function museAuthHit(error: { kind?: unknown; message?: unknown } | null | undefined): AuthHit | null {
  if (!error || error.kind !== "authRequired") return null;
  const message = typeof error.message === "string" ? error.message : "";
  return { kind: /not logged in/i.test(message) ? "signedOut" : "stale", said: cut(message || "authRequired") };
}

/** Muse Code's words when `muse serve` itself wouldn't start for want of a sign-in (it has no typed error there). */
export function museStartAuthHit(message: string): AuthHit | null {
  if (/not logged in|run `?muse login/i.test(message)) return { kind: "signedOut", said: cut(message) };
  if (/still unauthorized/i.test(message)) return { kind: "stale", said: cut(message) };
  return null;
}

/**
 * Agents on the Agent Client Protocol (Gemini CLI 0.62). Two signals, and nothing in the words of other messages:
 * - `session/new` or `session/prompt` refused with JSON-RPC -32000 "Authentication required" (its RequestError.authRequired,
 *   no sign-in, or one it couldn't load): signed out. The same code is what Crosstalk's own JSON-RPC layer uses for a
 *   process that went away ("Gemini CLI exited…", with its last lines), so the words must be exactly those.
 * - Google refusing the sign-in mid-session: its auth library raises the OAuth error code itself ("invalid_grant", a
 *   GaxiosError whose message it sets to it), which Gemini CLI passes on as an internal error's `details`: stale.
 * Not a sign-in: a Vertex AI or application-default credential's 401 ("UNAUTHENTICATED", "invalid authentication
 * credentials": cloud credentials, which a sign-in doesn't renew), an MCP server's own "unauthenticated", and
 * anything an exiting process printed.
 */
export function acpAuthHit(e: unknown): AuthHit | null {
  const code = typeof (e as { code?: unknown })?.code === "number" ? (e as { code: number }).code : null;
  const message = e instanceof Error ? e.message : String(e ?? "");
  if (code === -32000 && /^\s*Authentication required\b/i.test(message)) return { kind: "signedOut", said: cut(message) };
  // What the auth layer raised: an internal error's details, or the error itself when it isn't a JSON-RPC answer.
  const data = (e as { data?: unknown })?.data;
  const details = data && typeof data === "object" && typeof (data as { details?: unknown }).details === "string" ? (data as { details: string }).details : null;
  const raised = details ?? (code === null ? message : "");
  if (/^\s*invalid_grant\b/.test(raised)) return { kind: "stale", said: cut(raised) };
  return null;
}

/**
 * Antigravity CLI (1.4.11): its own sentence in a result's error, "Authentication expired. Please log back in." (1.3.3+:
 * an expired or revoked sign-in mid-session): stale. Only that sentence: its stderr says "not authenticated" and
 * "unauthenticated" about many other things (an MCP server skipped, a check that tries a silent sign-in first), so the
 * stderr is never read for this. When its sign-in is refused for good it signs itself out and clears the stored one
 * (1.2.5); what it says then is the driver's plain failure ("isn't signed in"), and its sign-in is its terminal's.
 */
export function agyAuthHit(text: string | null | undefined): AuthHit | null {
  const s = String(text ?? "");
  return /\bAuthentication expired\. Please log back in\b/i.test(s) ? { kind: "stale", said: cut(s) } : null;
}
