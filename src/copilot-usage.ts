import { z } from "zod";
import type { UsageMeasurement } from "./usage-contract.js";

export type CopilotUsage = UsageMeasurement["usage"];
export type CopilotUsageReading = { accountKey: string | null; usage: CopilotUsage };

export type CopilotCredential = {
  token: string;
  /** Web origin of the account, e.g. `https://github.com`. */
  host: string;
  /** Where the token came from, for diagnostics; never the token itself. */
  source: string;
};

export type UsageFetch = (
  input: string,
  init: { headers: Record<string, string>; signal?: AbortSignal },
) => Promise<{ ok: boolean; status: number; json: () => Promise<unknown> }>;

export const KEYCHAIN_SERVICE = "copilot-cli";
export const DEFAULT_HOST = "https://github.com";
const USAGE_TIMEOUT_MS = 8_000;

/** The env tokens Copilot CLI honours, in its own order of precedence. */
export const TOKEN_ENV_VARS = ["COPILOT_GITHUB_TOKEN", "GH_TOKEN", "GITHUB_TOKEN"] as const;

/** `quota_snapshots` keys reported as windows, in display order. */
const QUOTAS = [
  ["premium_interactions", "Premium requests"],
  ["chat", "Chat messages"],
  ["completions", "Code completions"],
] as const;

const PLAN_LABELS: Record<string, string> = {
  free: "Free",
  individual: "Pro",
  individual_pro: "Pro+",
  business: "Business",
  enterprise: "Enterprise",
};

const snapshotSchema = z.object({
  unlimited: z.boolean().optional(),
  percent_remaining: z.number().finite().optional(),
}).passthrough();

const copilotUserSchema = z.object({
  id: z.union([z.number(), z.string()]).optional(),
  copilot_plan: z.string().min(1).optional(),
  quota_reset_date_utc: z.string().min(1).optional(),
  quota_snapshots: z.record(z.string(), z.unknown()).optional(),
}).passthrough();

const ACCOUNT_FIELDS = { plan: null, accountEmail: null, planLabel: null } as const;

export function usageStatus(
  status: "not_installed" | "unauthenticated" | "expired",
): CopilotUsageReading {
  return { accountKey: null, usage: { status, ...ACCOUNT_FIELDS } };
}

export function usageError(message: string): CopilotUsageReading {
  return { accountKey: null, usage: { status: "error", ...ACCOUNT_FIELDS, message } };
}

export function normalizeHost(value: string | undefined): string | null {
  const trimmed = value?.trim();
  if (!trimmed) return null;
  try {
    const url = new URL(/^[a-z]+:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`);
    return url.origin;
  } catch {
    return null;
  }
}

/** REST API root for a GitHub web origin: dotcom, GHE.com data residency, or GHES. */
export function apiBaseUrl(host: string): string {
  const url = new URL(host);
  if (url.hostname === "github.com") return "https://api.github.com";
  if (url.hostname.endsWith(".ghe.com")) return `${url.protocol}//api.${url.hostname}`;
  return `${url.origin}/api/v3`;
}

/**
 * Copilot's own quota report (`GET /copilot_internal/user`, the call the CLI
 * makes at session start) as a provider-usage measurement. Unlimited quotas
 * and snapshots without a percentage are left out rather than shown as 0%.
 */
export function parseCopilotUser(payload: unknown, host: string): CopilotUsageReading {
  const parsed = copilotUserSchema.safeParse(payload);
  if (!parsed.success) return usageError("GitHub returned an unrecognised Copilot quota response.");
  const user = parsed.data;
  const resetsAt = user.quota_reset_date_utc ?? null;
  const windows = QUOTAS.flatMap(([id, label]) => {
    const snapshot = snapshotSchema.safeParse(user.quota_snapshots?.[id]);
    if (!snapshot.success) return [];
    const { unlimited, percent_remaining: remaining } = snapshot.data;
    if (unlimited === true || remaining === undefined) return [];
    return [{
      kind: "custom" as const,
      id,
      label,
      // Negative remaining means overage; the contract allows more than 100.
      usedPercent: Math.round(Math.max(0, 100 - remaining) * 100) / 100,
      resetsAt,
      model: null,
      cost: null,
    }];
  });
  const planId = user.copilot_plan ?? null;
  return {
    accountKey: user.id === undefined ? null : `${new URL(host).hostname}:copilot-user:${user.id}`,
    usage: {
      status: "ok",
      plan: planId === null ? null : { id: planId, multiplier: null },
      accountEmail: null,
      planLabel: planId === null ? null : (PLAN_LABELS[planId] ?? planId),
      windows,
    },
  };
}

export async function fetchCopilotUsage(
  credential: CopilotCredential,
  fetchImpl: UsageFetch,
  timeoutMs = USAGE_TIMEOUT_MS,
): Promise<CopilotUsageReading> {
  let response: Awaited<ReturnType<UsageFetch>>;
  try {
    response = await fetchImpl(`${apiBaseUrl(credential.host)}/copilot_internal/user`, {
      headers: {
        Authorization: `token ${credential.token}`,
        Accept: "application/json",
        "User-Agent": "bb-plugin-gh-copilot",
        "X-GitHub-Api-Version": "2025-04-01",
      },
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (error) {
    return usageError(`Could not reach GitHub for Copilot quota: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (response.status === 401) return usageStatus("expired");
  // No Copilot quota endpoint for this account or host: a plan without
  // reported limits, not an outage.
  if (response.status === 404 || response.status === 501) {
    return { accountKey: null, usage: { status: "ok", ...ACCOUNT_FIELDS, windows: [] } };
  }
  if (!response.ok) return usageError(`GitHub returned HTTP ${response.status} for Copilot quota.`);
  try {
    return parseCopilotUser(await response.json(), credential.host);
  } catch {
    return usageError("GitHub returned an unreadable Copilot quota response.");
  }
}

export type CredentialSources = {
  /** Environment Copilot runs with: the managed agent's `env` over the process env. */
  env: Record<string, string | undefined>;
  /** Contents of `$COPILOT_HOME/config.json`, or null when absent. */
  readConfig: () => string | null;
  /** OS credential store lookup; null when absent or unsupported. */
  readSecret: (service: string, account: string) => Promise<string | null>;
};

const loggedInUserSchema = z.object({ host: z.string().min(1), login: z.string().min(1) });

/** Copilot's config.json is JSON with `//` comment lines. */
export function parseCopilotConfig(text: string | null): Record<string, unknown> {
  if (text === null) return {};
  try {
    const parsed: unknown = JSON.parse(
      text.split("\n").filter((line) => !line.trimStart().startsWith("//")).join("\n"),
    );
    return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {};
  } catch {
    return {};
  }
}

/**
 * The token Copilot CLI itself would use: an env token first, then the
 * stored login of the last signed-in user — OS keychain, then the plaintext
 * `copilot_tokens` fallback the CLI writes when no keychain is available.
 */
export async function resolveCopilotCredential(sources: CredentialSources): Promise<CopilotCredential | null> {
  const config = parseCopilotConfig(sources.readConfig());
  const lastUser = loggedInUserSchema.safeParse(config.lastLoggedInUser ?? config.last_logged_in_user);
  const envHost = normalizeHost(sources.env.COPILOT_GH_HOST) ?? normalizeHost(sources.env.GH_HOST);

  for (const name of TOKEN_ENV_VARS) {
    const token = sources.env[name]?.trim();
    if (token) {
      return {
        token,
        host: envHost ?? (lastUser.success ? normalizeHost(lastUser.data.host) : null) ?? DEFAULT_HOST,
        source: name,
      };
    }
  }

  if (!lastUser.success) return null;
  const host = normalizeHost(lastUser.data.host);
  if (host === null) return null;
  const account = `${host}:${lastUser.data.login}`;
  const stored = (await sources.readSecret(KEYCHAIN_SERVICE, account))?.trim();
  if (stored) return { token: stored, host, source: "keychain" };

  for (const key of ["copilotTokens", "copilot_tokens"]) {
    const tokens = config[key];
    if (tokens !== null && typeof tokens === "object") {
      const token = (tokens as Record<string, unknown>)[account];
      if (typeof token === "string" && token.trim()) return { token: token.trim(), host, source: "config" };
    }
  }
  return null;
}

export async function readCopilotUsage(args: {
  binary: string | null;
  credential: () => Promise<CopilotCredential | null>;
  fetch: UsageFetch;
}): Promise<CopilotUsageReading> {
  if (args.binary === null) return usageStatus("not_installed");
  let credential: CopilotCredential | null;
  try {
    credential = await args.credential();
  } catch (error) {
    return usageError(`Could not read Copilot credentials: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (credential === null) return usageStatus("unauthenticated");
  return fetchCopilotUsage(credential, args.fetch);
}
