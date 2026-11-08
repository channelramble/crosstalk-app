import type { Provider } from "@crosstalk/shared";

/** Default sign-ins retain the old provider key; named accounts never overwrite it. */
export function accountKey(provider: Provider, accountId?: string | null): string {
  return accountId && accountId !== "default" ? `${provider}:${accountId}` : provider;
}

/** Scope an existing provider route to one named account. */
export function accountQuery(path: string, accountId?: string | null): string {
  return accountId && accountId !== "default" ? `${path}${path.includes("?") ? "&" : "?"}account=${encodeURIComponent(accountId)}` : path;
}

export { memberAccount } from "@crosstalk/shared";

/** Keep a user's label separate from the detected sign-in identity. */
export function accountDescription(label: string, email?: string | null): string {
  return email && email !== label ? `${label} · ${email}` : label;
}
