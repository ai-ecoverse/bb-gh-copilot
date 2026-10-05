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

/**
 * Copilot rejects classic PATs; an interactive CLI ignores one and moves on
 * to the next credential, so quota is read with that next credential too.
 */
export function isSupportedToken(token: string): boolean {
  return !token.startsWith("ghp_");
}

/** The env tokens Copilot CLI honours, in its own order of precedence. */
export const TOKEN_ENV_VARS = ["COPILOT_GITHUB_TOKEN", "GH_TOKEN", "GITHUB_TOKEN"] as const;

/**
 * Windows in display order, with the `quota_snapshots` keys that feed each,
 * newest first: premium requests moved from `premium_interactions` to
 * `premium_models`, and VS Code reads the latter before the former.
 */
const QUOTAS = [
  ["premium_interactions", "Premium requests", ["premium_models", "premium_interactions"]],
  ["chat", "Chat messages", ["chat"]],
  ["completions", "Code completions", ["completions"]],
] as const;

const PLAN_LABELS: Record<string, string> = {
  free: "Free",
  individual: "Pro",
  individual_pro: "Pro+",
  business: "Business",
  enterprise: "Enterprise",
};

const numeric = z.union([z.number(), z.string()]).transform(Number).pipe(z.number().finite());

/** The SDK types these fields as nullable; null means absent. */
function nullable<T extends z.ZodTypeAny>(schema: T) {
  return schema.nullish().transform((value): z.output<T> | undefined => value ?? undefined);
}

const snapshotSchema = z.object({
  unlimited: nullable(z.boolean()),
  percent_remaining: nullable(z.number().finite()),
  entitlement: nullable(numeric),
  remaining: nullable(numeric),
  quota_remaining: nullable(numeric),
  has_quota: nullable(z.boolean()),
  token_based_billing: nullable(z.boolean()),
  // Reset times vary in type (the SDK types quota_reset_at as epoch seconds),
  // so they are read leniently and never invalidate a quota.
  quota_reset_at: z.unknown().optional(),
  reset_date: z.unknown().optional(),
}).passthrough();

const copilotUserSchema = z.object({
  id: z.union([z.number(), z.string()]).optional(),
  copilot_plan: nullable(z.string().min(1)),
  // Free accounts report the generic `individual` plan; the SKU tells them apart.
  access_type_sku: nullable(z.string()),
  // AI-credit billing replaced request-based billing; legacy plans keep requests.
  token_based_billing: nullable(z.boolean()),
  quota_reset_date_utc: z.unknown().optional(),
  quota_reset_date: z.unknown().optional(),
  quota_snapshots: z.record(z.string(), z.unknown()).optional(),
  // Legacy Copilot Free: remaining and monthly allowance per category.
  limited_user_quotas: z.record(z.string(), z.unknown()).optional(),
  monthly_quotas: z.record(z.string(), z.unknown()).optional(),
  limited_user_reset_date: z.unknown().optional(),
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

/** An ISO timestamp from a date string or Unix epoch seconds; null otherwise. */
function isoTimestamp(value: unknown): string | null {
  const time = typeof value === "string" && value.trim()
    ? Date.parse(value)
    : typeof value === "number" && Number.isFinite(value) && value > 0 ? value * 1000 : Number.NaN;
  return Number.isNaN(time) ? null : new Date(time).toISOString();
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

type CopilotUser = z.infer<typeof copilotUserSchema>;

/** Percentage used for one quota category, or null when it has no finite limit. */
function quotaUsage(
  user: CopilotUser,
  id: string,
  snapshotKeys: readonly string[],
): { usedPercent: number; resetsAt: string | null; credits: boolean } | null {
  const defaultReset = isoTimestamp(user.quota_reset_date_utc)
    ?? isoTimestamp(user.quota_reset_date)
    ?? isoTimestamp(user.limited_user_reset_date);
  const raw = snapshotKeys.map((key) => user.quota_snapshots?.[key]).find((value) => value !== undefined);
  if (raw !== undefined) {
    const snapshot = snapshotSchema.safeParse(raw);
    if (!snapshot.success) return null;
    const { unlimited, entitlement, has_quota: hasQuota } = snapshot.data;
    const left = snapshot.data.remaining ?? snapshot.data.quota_remaining;
    const remaining = snapshot.data.percent_remaining
      ?? (left !== undefined && entitlement !== undefined && entitlement > 0 ? (left / entitlement) * 100 : undefined);
    const resetsAt = isoTimestamp(snapshot.data.quota_reset_at) ?? isoTimestamp(snapshot.data.reset_date) ?? defaultReset;
    const credits = (snapshot.data.token_based_billing ?? user.token_based_billing) === true;
    if (unlimited === true || entitlement === -1) {
      // An unlimited per-user share of a pooled entitlement runs out when
      // the pool does; has_quota false is the only signal of that.
      return hasQuota === false ? { usedPercent: 100, resetsAt, credits } : null;
    }
    // A zero entitlement (e.g. Free's premium requests) is no allowance, not a spent one.
    if (remaining === undefined || entitlement === 0) return null;
    return {
      // Negative remaining means overage; the contract allows more than 100.
      usedPercent: round2(Math.max(0, 100 - remaining)),
      resetsAt,
      credits,
    };
  }
  const monthly = numeric.safeParse(user.monthly_quotas?.[id]);
  const left = numeric.safeParse(user.limited_user_quotas?.[id]);
  if (!monthly.success || !left.success || monthly.data <= 0) return null;
  return {
    usedPercent: round2(Math.max(0, 100 - (left.data / monthly.data) * 100)),
    resetsAt: defaultReset,
    credits: user.token_based_billing === true,
  };
}

/**
 * Copilot's own quota report (`GET /copilot_internal/user`, the call the CLI
 * makes at session start) as a provider-usage measurement. `quota_snapshots`
 * win; legacy Free accounts report `limited_user_quotas` against
 * `monthly_quotas` instead. Unlimited quotas (unless their pool is spent),
 * zero allowances, and snapshots without a percentage or the counts to derive
 * one are left out rather than shown as 0% or 100%.
 */
export function parseCopilotUser(payload: unknown, host: string): CopilotUsageReading {
  const parsed = copilotUserSchema.safeParse(payload);
  if (!parsed.success) return usageError("GitHub returned an unrecognised Copilot quota response.");
  const user = parsed.data;
  const windows = QUOTAS.flatMap(([id, label, snapshotKeys]) => {
    const quota = quotaUsage(user, id, snapshotKeys);
    if (quota === null) return [];
    const { credits, ...used } = quota;
    // The billing marker sits on the user response, the snapshot, or both.
    const shown = id === "premium_interactions" && credits ? "AI credits" : label;
    return [{ kind: "custom" as const, id, label: shown, ...used, model: null, cost: null }];
  });
  const planId = user.access_type_sku === "free_limited_copilot" ? "free" : (user.copilot_plan ?? null);
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
  /**
   * Variables set explicitly in the managed agent's `env`, as opposed to
   * inherited from bb's environment. Only matters for Codespaces' injected
   * `GITHUB_TOKEN`, which an explicit setting overrides.
   */
  explicitEnv?: ReadonlySet<string>;
  /**
   * The `GITHUB_TOKEN` values Codespaces injected. An inherited token that
   * differs was exported by the user and keeps its precedence; when none are
   * known, an inherited token is assumed to be the injected one.
   */
  injectedGithubTokens?: () => readonly string[];
  /** Contents of `$COPILOT_HOME/config.json`, or null when absent. */
  readConfig: () => string | null;
  /** OS credential store lookup; null when absent or unsupported. */
  readSecret: (service: string, account: string) => Promise<string | null>;
  /** `gh auth token --hostname <hostname>`; null when gh is absent or signed out. */
  readGhToken?: (hostname: string) => Promise<string | null>;
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

type StoredUser = z.infer<typeof loggedInUserSchema>;

/**
 * The stored login to use: the last signed-in user, unless a host override
 * points elsewhere, in which case the signed-in user for that host, if any.
 */
function storedUser(config: Record<string, unknown>, hostOverride: string | null): StoredUser | null {
  const parse = (value: unknown) => {
    const user = loggedInUserSchema.safeParse(value);
    return user.success ? user.data : null;
  };
  const last = parse(config.lastLoggedInUser ?? config.last_logged_in_user);
  if (hostOverride === null) return last;
  const others = config.loggedInUsers ?? config.logged_in_users;
  return [last, ...(Array.isArray(others) ? others.map(parse) : [])]
    .find((user) => user !== null && normalizeHost(user.host) === hostOverride) ?? null;
}

async function storedLogin(
  sources: CredentialSources,
  config: Record<string, unknown>,
  lastUser: StoredUser | null,
): Promise<CopilotCredential | null> {
  if (lastUser === null) return null;
  const host = normalizeHost(lastUser.host);
  if (host === null) return null;
  const account = `${host}:${lastUser.login}`;
  const stored = (await sources.readSecret(KEYCHAIN_SERVICE, account))?.trim();
  if (stored && isSupportedToken(stored)) return { token: stored, host, source: "keychain" };

  for (const key of ["copilotTokens", "copilot_tokens"]) {
    const tokens = config[key];
    if (tokens !== null && typeof tokens === "object") {
      const token = (tokens as Record<string, unknown>)[account];
      if (typeof token === "string" && token.trim() && isSupportedToken(token.trim())) {
        return { token: token.trim(), host, source: "config" };
      }
    }
  }
  return null;
}

/**
 * The token Copilot CLI itself would use, in its documented order: env
 * tokens, then the stored login of the last signed-in user (OS keychain, or
 * the plaintext `copilot_tokens` fallback written when no keychain is
 * available), then `gh auth token`. In Codespaces the automatically injected
 * `GITHUB_TOKEN` does not override a stored login, so an inherited one that
 * matches the token Codespaces recorded (or any, when none is recorded) is
 * tried after it. A `COPILOT_GH_HOST`/`GH_HOST` override only uses a login
 * stored for that host. Classic PATs are skipped wherever they turn up.
 */
export async function resolveCopilotCredential(sources: CredentialSources): Promise<CopilotCredential | null> {
  const config = parseCopilotConfig(sources.readConfig());
  const envHost = normalizeHost(sources.env.COPILOT_GH_HOST) ?? normalizeHost(sources.env.GH_HOST);
  const lastUser = storedUser(config, envHost);
  const host = envHost ?? (lastUser ? normalizeHost(lastUser.host) : null) ?? DEFAULT_HOST;
  const inCodespace = Boolean(sources.env.CODESPACES);

  let injected: CopilotCredential | null = null;
  for (const name of TOKEN_ENV_VARS) {
    const token = sources.env[name]?.trim();
    if (!token || !isSupportedToken(token)) continue;
    if (name === "GITHUB_TOKEN" && inCodespace && !sources.explicitEnv?.has(name)) {
      const known = sources.injectedGithubTokens?.() ?? [];
      if (known.length === 0 || known.includes(token)) {
        injected = { token, host, source: name };
        break;
      }
    }
    return { token, host, source: name };
  }

  const stored = await storedLogin(sources, config, lastUser);
  if (stored) return stored;
  if (injected) return injected;

  const ghToken = (await sources.readGhToken?.(new URL(host).host))?.trim();
  return ghToken && isSupportedToken(ghToken) ? { token: ghToken, host, source: "gh" } : null;
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
