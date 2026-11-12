import { z } from 'zod';
import type { UsageMeasurement } from './usage-contract.ts';

export type CopilotUsage = UsageMeasurement['usage'];
export type CopilotUsageReading = { accountKey: string | null; usage: CopilotUsage };

export type CopilotCredential = {
  token: string;
  host: string;
  source: string;
};

export type UsageFetch = (
  input: string,
  init: { headers: Record<string, string>; signal?: AbortSignal }
) => Promise<{ ok: boolean; status: number; json: () => Promise<unknown> }>;

export const KEYCHAIN_SERVICE = 'copilot-cli';
export const DEFAULT_HOST = 'https://github.com';
const USAGE_TIMEOUT_MS = 8_000;

export function isSupportedToken(token: string): boolean {
  return !token.startsWith('ghp_');
}

export const TOKEN_ENV_VARS = ['COPILOT_GITHUB_TOKEN', 'GH_TOKEN', 'GITHUB_TOKEN'] as const;

const QUOTAS = [
  ['premium_interactions', 'Premium requests', ['premium_models', 'premium_interactions']],
  ['chat', 'Chat messages', ['chat']],
  ['completions', 'Code completions', ['completions']],
] as const;

const PLAN_LABELS: Record<string, string> = {
  free: 'Free',
  individual: 'Pro',
  individual_pro: 'Pro+',
  business: 'Business',
  enterprise: 'Enterprise',
};

const numeric = z.union([z.number(), z.string()]).transform(Number).pipe(z.number().finite());

function nullable<T extends z.ZodTypeAny>(schema: T) {
  return schema.nullish().transform((value): z.output<T> | undefined => value ?? undefined);
}

const snapshotSchema = z
  .object({
    unlimited: nullable(z.boolean()),
    percent_remaining: nullable(z.number().finite()),
    entitlement: nullable(numeric),
    remaining: nullable(numeric),
    quota_remaining: nullable(numeric),
    overage_count: nullable(numeric),
    has_quota: nullable(z.boolean()),
    token_based_billing: nullable(z.boolean()),
    quota_reset_at: z.unknown().optional(),
    reset_date: z.unknown().optional(),
  })
  .passthrough();

const copilotUserSchema = z
  .object({
    id: nullable(z.union([z.number(), z.string()])),
    copilot_plan: nullable(z.string().min(1)),
    access_type_sku: nullable(z.string()),
    token_based_billing: nullable(z.boolean()),
    quota_reset_date_utc: z.unknown().optional(),
    quota_reset_date: z.unknown().optional(),
    quota_snapshots: nullable(z.record(z.string(), z.unknown())),
    limited_user_quotas: nullable(z.record(z.string(), z.unknown())),
    monthly_quotas: nullable(z.record(z.string(), z.unknown())),
    limited_user_reset_date: z.unknown().optional(),
  })
  .passthrough();

const ACCOUNT_FIELDS = { plan: null, accountEmail: null, planLabel: null } as const;

export function usageStatus(
  status: 'not_installed' | 'unauthenticated' | 'expired'
): CopilotUsageReading {
  return { accountKey: null, usage: { status, ...ACCOUNT_FIELDS } };
}

export function usageError(message: string): CopilotUsageReading {
  return { accountKey: null, usage: { status: 'error', ...ACCOUNT_FIELDS, message } };
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

export function apiBaseUrl(host: string): string {
  const url = new URL(host);
  if (url.hostname === 'github.com') return 'https://api.github.com';
  if (url.hostname.endsWith('.ghe.com')) return `${url.protocol}//api.${url.hostname}`;
  return `${url.origin}/api/v3`;
}

function isoTimestamp(value: unknown): string | null {
  const time =
    typeof value === 'string' && value.trim()
      ? Date.parse(value)
      : typeof value === 'number' && Number.isFinite(value) && value > 0
        ? value * 1000
        : Number.NaN;
  return Number.isNaN(time) ? null : new Date(time).toISOString();
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

type CopilotUser = z.infer<typeof copilotUserSchema>;

type QuotaUsage = { usedPercent: number; resetsAt: string | null; credits: boolean };

function snapshotRemainingPercent(snapshot: z.infer<typeof snapshotSchema>): number | undefined {
  if (snapshot.percent_remaining !== undefined) return snapshot.percent_remaining;
  const left = snapshot.remaining ?? snapshot.quota_remaining;
  const { entitlement } = snapshot;
  if (left === undefined || entitlement === undefined || entitlement <= 0) return undefined;
  return (left / entitlement) * 100;
}

function overageUsedPercent(snapshot: z.infer<typeof snapshotSchema>): number {
  const { overage_count: overage, entitlement } = snapshot;
  if (overage === undefined || overage <= 0 || entitlement === undefined || entitlement <= 0) {
    return 0;
  }
  return 100 + (overage / entitlement) * 100;
}

function snapshotUsage(
  user: CopilotUser,
  raw: unknown,
  defaultReset: string | null
): QuotaUsage | null {
  const parsed = snapshotSchema.safeParse(raw);
  if (!parsed.success) return null;
  const snapshot = parsed.data;
  const { unlimited, entitlement, has_quota: hasQuota } = snapshot;
  const resetsAt =
    isoTimestamp(snapshot.quota_reset_at) ?? isoTimestamp(snapshot.reset_date) ?? defaultReset;
  const credits = (snapshot.token_based_billing ?? user.token_based_billing) === true;
  const quotaSpent = hasQuota === false;
  if (unlimited === true || entitlement === -1) {
    return quotaSpent ? { usedPercent: 100, resetsAt, credits } : null;
  }
  const noAllowance = entitlement === 0;
  if (noAllowance) return null;
  const overUsed = overageUsedPercent(snapshot);
  const floor = quotaSpent ? Math.max(100, overUsed) : overUsed;
  const remaining = snapshotRemainingPercent(snapshot);
  if (remaining === undefined) {
    return floor > 0 ? { usedPercent: round2(floor), resetsAt, credits } : null;
  }
  return { usedPercent: round2(Math.max(floor, 100 - remaining, 0)), resetsAt, credits };
}

function legacyAllowanceUsage(
  user: CopilotUser,
  id: string,
  defaultReset: string | null
): QuotaUsage | null {
  const monthly = numeric.safeParse(user.monthly_quotas?.[id]);
  const left = numeric.safeParse(user.limited_user_quotas?.[id]);
  if (!monthly.success || !left.success || monthly.data <= 0) return null;
  return {
    usedPercent: round2(Math.max(0, 100 - (left.data / monthly.data) * 100)),
    resetsAt: defaultReset,
    credits: user.token_based_billing === true,
  };
}

function quotaUsage(
  user: CopilotUser,
  id: string,
  snapshotKeys: readonly string[]
): QuotaUsage | null {
  const defaultReset =
    isoTimestamp(user.quota_reset_date_utc) ??
    isoTimestamp(user.quota_reset_date) ??
    isoTimestamp(user.limited_user_reset_date);
  const raw = snapshotKeys.map((key) => user.quota_snapshots?.[key]).find((value) => value != null);
  return raw != null
    ? snapshotUsage(user, raw, defaultReset)
    : legacyAllowanceUsage(user, id, defaultReset);
}

export function parseCopilotUser(payload: unknown, host: string): CopilotUsageReading {
  const parsed = copilotUserSchema.safeParse(payload);
  if (!parsed.success) return usageError('GitHub returned an unrecognised Copilot quota response.');
  const user = parsed.data;
  const windows = QUOTAS.flatMap(([id, label, snapshotKeys]) => {
    const quota = quotaUsage(user, id, snapshotKeys);
    if (quota === null) return [];
    const { credits, ...used } = quota;
    const shown = id === 'premium_interactions' && credits ? 'AI credits' : label;
    return [{ kind: 'custom' as const, id, label: shown, ...used, model: null, cost: null }];
  });
  const planId = user.access_type_sku?.startsWith('free_') ? 'free' : (user.copilot_plan ?? null);
  return {
    accountKey: user.id === undefined ? null : `${new URL(host).host}:copilot-user:${user.id}`,
    usage: {
      status: 'ok',
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
  timeoutMs = USAGE_TIMEOUT_MS
): Promise<CopilotUsageReading> {
  let response: Awaited<ReturnType<UsageFetch>>;
  try {
    response = await fetchImpl(`${apiBaseUrl(credential.host)}/copilot_internal/user`, {
      headers: {
        Authorization: `token ${credential.token}`,
        Accept: 'application/json',
        'User-Agent': 'bb-plugin-gh-copilot',
        'X-GitHub-Api-Version': '2025-04-01',
      },
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (error) {
    return usageError(
      `Could not reach GitHub for Copilot quota: ${error instanceof Error ? error.message : String(error)}`
    );
  }
  if (response.status === 401) return usageStatus('expired');
  if (response.status === 404) {
    return usageError(
      'GitHub returned HTTP 404 for Copilot quota. The token may lack Copilot access.'
    );
  }
  if (response.status === 501) {
    return { accountKey: null, usage: { status: 'ok', ...ACCOUNT_FIELDS, windows: [] } };
  }
  if (!response.ok) return usageError(`GitHub returned HTTP ${response.status} for Copilot quota.`);
  try {
    return parseCopilotUser(await response.json(), credential.host);
  } catch {
    return usageError('GitHub returned an unreadable Copilot quota response.');
  }
}

export type CredentialSources = {
  env: Record<string, string | undefined>;
  explicitEnv?: ReadonlySet<string>;
  injectedGithubTokens?: () => readonly string[];
  readConfig: () => string | null;
  readSecret: (service: string, account: string) => Promise<string | null>;
  readGhToken?: (hostname: string) => Promise<string | null>;
};

const loggedInUserSchema = z.object({ host: z.string().min(1), login: z.string().min(1) });

export function parseCopilotConfig(text: string | null): Record<string, unknown> {
  if (text === null) return {};
  try {
    const parsed: unknown = JSON.parse(
      text
        .split('\n')
        .filter((line) => !line.trimStart().startsWith('//'))
        .join('\n')
    );
    return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

type StoredUser = z.infer<typeof loggedInUserSchema>;

function storedUser(
  config: Record<string, unknown>,
  hostOverride: string | null
): StoredUser | null {
  const parse = (value: unknown) => {
    const user = loggedInUserSchema.safeParse(value);
    return user.success ? user.data : null;
  };
  const last = parse(config.lastLoggedInUser ?? config.last_logged_in_user);
  if (hostOverride === null) return last;
  const others = config.loggedInUsers ?? config.logged_in_users;
  return (
    [last, ...(Array.isArray(others) ? others.map(parse) : [])].find(
      (user) => user !== null && normalizeHost(user.host) === hostOverride
    ) ?? null
  );
}

async function storedLogin(
  sources: CredentialSources,
  config: Record<string, unknown>,
  lastUser: StoredUser | null
): Promise<CopilotCredential | null> {
  if (lastUser === null) return null;
  const host = normalizeHost(lastUser.host);
  if (host === null) return null;
  const account = `${host}:${lastUser.login}`;
  const stored = (await sources.readSecret(KEYCHAIN_SERVICE, account))?.trim();
  if (stored && isSupportedToken(stored)) return { token: stored, host, source: 'keychain' };

  for (const key of ['copilotTokens', 'copilot_tokens']) {
    const tokens = config[key];
    if (tokens !== null && typeof tokens === 'object') {
      const token = (tokens as Record<string, unknown>)[account];
      if (typeof token === 'string' && token.trim() && isSupportedToken(token.trim())) {
        return { token: token.trim(), host, source: 'config' };
      }
    }
  }
  return null;
}

export async function resolveCopilotCredential(
  sources: CredentialSources
): Promise<CopilotCredential | null> {
  const config = parseCopilotConfig(sources.readConfig());
  const envHost = normalizeHost(sources.env.COPILOT_GH_HOST) ?? normalizeHost(sources.env.GH_HOST);
  const lastUser = storedUser(config, envHost);
  const host = envHost ?? (lastUser ? normalizeHost(lastUser.host) : null) ?? DEFAULT_HOST;
  const inCodespace = Boolean(sources.env.CODESPACES);

  let injected: CopilotCredential | null = null;
  for (const name of TOKEN_ENV_VARS) {
    const token = sources.env[name]?.trim();
    if (!token || !isSupportedToken(token)) continue;
    if (name === 'GITHUB_TOKEN' && inCodespace && !sources.explicitEnv?.has(name)) {
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
  return ghToken && isSupportedToken(ghToken) ? { token: ghToken, host, source: 'gh' } : null;
}

export async function readCopilotUsage(args: {
  binary: string | null;
  credential: () => Promise<CopilotCredential | null>;
  fetch: UsageFetch;
}): Promise<CopilotUsageReading> {
  if (args.binary === null) return usageStatus('not_installed');
  let credential: CopilotCredential | null;
  try {
    credential = await args.credential();
  } catch (error) {
    return usageError(
      `Could not read Copilot credentials: ${error instanceof Error ? error.message : String(error)}`
    );
  }
  if (credential === null) return usageStatus('unauthenticated');
  return fetchCopilotUsage(credential, args.fetch);
}
