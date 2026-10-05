import { describe, expect, it, vi } from "vitest";
import {
  apiBaseUrl,
  fetchCopilotUsage,
  parseCopilotUser,
  readCopilotUsage,
  resolveCopilotCredential,
  type CredentialSources,
  type UsageFetch,
} from "./copilot-usage.js";
import { usageMeasurementSchema } from "./usage-contract.js";

const HOST = "https://github.com";

// Shape observed from GET /copilot_internal/user for a Business seat.
const BUSINESS_USER = {
  id: 161513220,
  login: "octocat",
  copilot_plan: "business",
  quota_reset_date: "2026-11-01",
  quota_reset_date_utc: "2026-11-01T00:00:00.000Z",
  quota_snapshots: {
    chat: { percent_remaining: 100, unlimited: true, quota_id: "chat" },
    completions: { percent_remaining: 100, unlimited: true, quota_id: "completions" },
    premium_interactions: {
      percent_remaining: 95.3,
      unlimited: false,
      overage_permitted: true,
      entitlement: 60000,
      remaining: 57228,
      quota_id: "premium_interactions",
    },
  },
};

function respond(status: number, body: unknown = {}): UsageFetch {
  return vi.fn(async () => ({ ok: status >= 200 && status < 300, status, json: async () => body }));
}

describe("parseCopilotUser", () => {
  it("reports premium requests and skips unlimited quotas", () => {
    const reading = parseCopilotUser(BUSINESS_USER, HOST);
    expect(reading.accountKey).toBe("github.com:copilot-user:161513220");
    expect(reading.usage).toEqual({
      status: "ok",
      plan: { id: "business", multiplier: null },
      accountEmail: null,
      planLabel: "Business",
      windows: [{
        kind: "custom",
        id: "premium_interactions",
        label: "Premium requests",
        usedPercent: 4.7,
        resetsAt: "2026-11-01T00:00:00.000Z",
        model: null,
        cost: null,
      }],
    });
    expect(usageMeasurementSchema.safeParse({ ...reading, observedAt: 1 }).success).toBe(true);
  });

  it("reports chat and completion snapshot limits and labels individual plans", () => {
    const reading = parseCopilotUser({
      id: 1,
      copilot_plan: "individual",
      quota_snapshots: {
        chat: { percent_remaining: 40, unlimited: false },
        completions: { percent_remaining: 90, unlimited: false },
        premium_interactions: { percent_remaining: -12.5, unlimited: false },
      },
    }, HOST);
    expect(reading.usage.status).toBe("ok");
    if (reading.usage.status !== "ok") return;
    expect(reading.usage.planLabel).toBe("Pro");
    expect(reading.usage.windows.map((w) => [w.id, w.usedPercent, w.resetsAt])).toEqual([
      ["premium_interactions", 112.5, null],
      ["chat", 60, null],
      ["completions", 10, null],
    ]);
  });

  it("labels Free by access SKU and token-billed premium quota as AI credits", () => {
    const free = parseCopilotUser({
      copilot_plan: "individual",
      access_type_sku: "free_limited_copilot",
    }, HOST);
    if (free.usage.status !== "ok") throw new Error("expected ok");
    expect(free.usage.plan).toEqual({ id: "free", multiplier: null });
    expect(free.usage.planLabel).toBe("Free");

    const credits = parseCopilotUser({
      copilot_plan: "business",
      token_based_billing: true,
      quota_snapshots: { premium_interactions: { percent_remaining: 70, unlimited: false } },
    }, HOST);
    if (credits.usage.status !== "ok") throw new Error("expected ok");
    expect(credits.usage.windows.map((w) => [w.id, w.label, w.usedPercent])).toEqual([
      ["premium_interactions", "AI credits", 30],
    ]);

    const snapshotMarked = parseCopilotUser({
      quota_snapshots: {
        premium_models: { percent_remaining: 40, unlimited: false, token_based_billing: true },
      },
    }, HOST);
    if (snapshotMarked.usage.status !== "ok") throw new Error("expected ok");
    expect(snapshotMarked.usage.windows.map((w) => [w.id, w.label, w.usedPercent])).toEqual([
      ["premium_interactions", "AI credits", 60],
    ]);
  });

  it("degrades to no windows rather than a fake 0%", () => {
    const reading = parseCopilotUser({ quota_snapshots: { premium_interactions: { unlimited: false } } }, HOST);
    expect(reading).toEqual({
      accountKey: null,
      usage: { status: "ok", plan: null, accountEmail: null, planLabel: null, windows: [] },
    });
  });

  it("reads legacy Free allowances and normalizes the reset date", () => {
    const reading = parseCopilotUser({
      id: 2,
      copilot_plan: "free",
      limited_user_quotas: { chat: 10, completions: 1500 },
      monthly_quotas: { chat: 50, completions: "2000" },
      limited_user_reset_date: "2026-11-05",
      quota_snapshots: {
        // Free has no premium allowance: zero entitlement, not 100% spent.
        premium_interactions: { percent_remaining: 0, unlimited: false, entitlement: 0 },
      },
    }, HOST);
    expect(reading.usage.status).toBe("ok");
    if (reading.usage.status !== "ok") return;
    expect(reading.usage.planLabel).toBe("Free");
    expect(reading.usage.windows.map((w) => [w.id, w.usedPercent, w.resetsAt])).toEqual([
      ["chat", 80, "2026-11-05T00:00:00.000Z"],
      ["completions", 25, "2026-11-05T00:00:00.000Z"],
    ]);
    expect(usageMeasurementSchema.safeParse({ ...reading, observedAt: 1 }).success).toBe(true);
  });

  it("prefers snapshots over legacy fields and per-snapshot reset times", () => {
    const reading = parseCopilotUser({
      quota_reset_date_utc: "2026-11-01T00:00:00.000Z",
      limited_user_quotas: { chat: 0 },
      monthly_quotas: { chat: 50 },
      quota_snapshots: {
        chat: { percent_remaining: 70, unlimited: false, quota_reset_at: "2026-10-06T12:00:00Z" },
      },
    }, HOST);
    if (reading.usage.status !== "ok") throw new Error("expected ok");
    expect(reading.usage.windows.map((w) => [w.id, w.usedPercent, w.resetsAt])).toEqual([
      ["chat", 30, "2026-10-06T12:00:00.000Z"],
    ]);
  });

  it("reads premium_models before premium_interactions", () => {
    const reading = parseCopilotUser({
      quota_snapshots: {
        premium_models: { percent_remaining: 20, unlimited: false, reset_date: "2026-11-01" },
        premium_interactions: { percent_remaining: 90, unlimited: false },
      },
    }, HOST);
    if (reading.usage.status !== "ok") throw new Error("expected ok");
    expect(reading.usage.windows.map((w) => [w.id, w.label, w.usedPercent, w.resetsAt])).toEqual([
      ["premium_interactions", "Premium requests", 80, "2026-11-01T00:00:00.000Z"],
    ]);
  });

  it("derives the percentage from remaining and entitlement when it is missing", () => {
    const reading = parseCopilotUser({
      copilot_plan: null,
      quota_snapshots: {
        premium_interactions: { unlimited: false, entitlement: 300, remaining: 75, percent_remaining: null },
        chat: { unlimited: false, entitlement: "50", quota_remaining: 50 },
        completions: { unlimited: false, remaining: 10 },
      },
    }, HOST);
    if (reading.usage.status !== "ok") throw new Error("expected ok");
    expect(reading.usage.windows.map((w) => [w.id, w.usedPercent])).toEqual([
      ["premium_interactions", 75],
      ["chat", 0],
    ]);
  });

  it("reports an exhausted pooled entitlement instead of hiding it", () => {
    const reading = parseCopilotUser({
      quota_reset_date_utc: "2026-11-01T00:00:00.000Z",
      quota_snapshots: {
        premium_models: { unlimited: true, has_quota: false, percent_remaining: 100 },
        chat: { unlimited: true, has_quota: true, percent_remaining: 100 },
        completions: { entitlement: -1, percent_remaining: 100 },
      },
    }, HOST);
    if (reading.usage.status !== "ok") throw new Error("expected ok");
    expect(reading.usage.windows.map((w) => [w.id, w.usedPercent, w.resetsAt])).toEqual([
      ["premium_interactions", 100, "2026-11-01T00:00:00.000Z"],
    ]);
  });

  it("skips a null premium_models alias and keeps the port in account keys", () => {
    const reading = parseCopilotUser({
      id: 7,
      quota_snapshots: {
        premium_models: null,
        premium_interactions: { unlimited: false, percent_remaining: 40 },
      },
    }, "https://git.example:8443");
    expect(reading.accountKey).toBe("git.example:8443:copilot-user:7");
    if (reading.usage.status !== "ok") throw new Error("expected ok");
    expect(reading.usage.windows.map((w) => [w.id, w.usedPercent])).toEqual([["premium_interactions", 60]]);
  });

  it("treats null quota containers and ids as absent", () => {
    const reading = parseCopilotUser({
      id: null,
      quota_snapshots: null,
      limited_user_quotas: { chat: 25 },
      monthly_quotas: { chat: 50 },
    }, HOST);
    expect(reading.accountKey).toBeNull();
    if (reading.usage.status !== "ok") throw new Error("expected ok");
    expect(reading.usage.windows.map((w) => [w.id, w.usedPercent])).toEqual([["chat", 50]]);
    expect(parseCopilotUser({ limited_user_quotas: null, monthly_quotas: null }, HOST).usage.status).toBe("ok");
  });

  it("reports a finite snapshot without quota as exhausted", () => {
    const reading = parseCopilotUser({
      quota_snapshots: {
        premium_interactions: { unlimited: false, entitlement: 300, has_quota: false },
        chat: { unlimited: false, entitlement: 50, has_quota: false, percent_remaining: 20 },
        completions: { unlimited: false, entitlement: 0, has_quota: false },
      },
    }, HOST);
    if (reading.usage.status !== "ok") throw new Error("expected ok");
    expect(reading.usage.windows.map((w) => [w.id, w.usedPercent])).toEqual([
      ["premium_interactions", 100],
      ["chat", 100],
    ]);
  });

  it("reads epoch-second reset times and never drops a quota over its reset field", () => {
    const reading = parseCopilotUser({
      quota_reset_date_utc: false,
      quota_snapshots: {
        premium_interactions: { percent_remaining: 75, unlimited: false, quota_reset_at: 1_791_201_600 },
        chat: { percent_remaining: 50, unlimited: false, quota_reset_at: { weird: true } },
      },
    }, HOST);
    if (reading.usage.status !== "ok") throw new Error("expected ok");
    expect(reading.usage.windows.map((w) => [w.id, w.usedPercent, w.resetsAt])).toEqual([
      ["premium_interactions", 25, "2026-10-05T12:00:00.000Z"],
      ["chat", 50, null],
    ]);
  });

  it("rejects a non-object payload", () => {
    expect(parseCopilotUser("nope", HOST).usage.status).toBe("error");
  });
});

describe("apiBaseUrl", () => {
  it("maps dotcom, GHE.com, and GHES hosts", () => {
    expect(apiBaseUrl("https://github.com")).toBe("https://api.github.com");
    expect(apiBaseUrl("https://acme.ghe.com")).toBe("https://api.acme.ghe.com");
    expect(apiBaseUrl("https://git.acme.test")).toBe("https://git.acme.test/api/v3");
  });
});

describe("fetchCopilotUsage", () => {
  const credential = { token: "gho_test", host: HOST, source: "keychain" };

  it("calls the Copilot user endpoint with the token", async () => {
    const fetchImpl = respond(200, BUSINESS_USER);
    const reading = await fetchCopilotUsage(credential, fetchImpl);
    expect(reading.usage.status).toBe("ok");
    expect(fetchImpl).toHaveBeenCalledWith(
      "https://api.github.com/copilot_internal/user",
      expect.objectContaining({ headers: expect.objectContaining({ Authorization: "token gho_test" }) }),
    );
  });

  it("maps HTTP statuses to usage states", async () => {
    expect((await fetchCopilotUsage(credential, respond(401))).usage.status).toBe("expired");
    expect((await fetchCopilotUsage(credential, respond(404))).usage).toMatchObject({ status: "ok", windows: [] });
    expect((await fetchCopilotUsage(credential, respond(501))).usage).toMatchObject({ status: "ok", windows: [] });
    expect((await fetchCopilotUsage(credential, respond(500))).usage).toMatchObject({
      status: "error",
      message: "GitHub returned HTTP 500 for Copilot quota.",
    });
  });

  it("reports network failures without throwing", async () => {
    const reading = await fetchCopilotUsage(credential, vi.fn(async () => { throw new Error("offline"); }));
    expect(reading.usage).toMatchObject({ status: "error", message: expect.stringContaining("offline") });
  });
});

describe("resolveCopilotCredential", () => {
  const config = JSON.stringify({ lastLoggedInUser: { host: HOST, login: "octocat" } });

  function sources(overrides: Partial<CredentialSources> = {}): CredentialSources {
    return { env: {}, readConfig: () => config, readSecret: async () => null, ...overrides };
  }

  it("prefers env tokens in Copilot CLI order", async () => {
    const credential = await resolveCopilotCredential(sources({
      env: { GITHUB_TOKEN: "c", GH_TOKEN: "b", COPILOT_GITHUB_TOKEN: "a" },
      readSecret: async () => "stored",
    }));
    expect(credential).toEqual({ token: "a", host: HOST, source: "COPILOT_GITHUB_TOKEN" });
  });

  it("targets COPILOT_GH_HOST over GH_HOST for env tokens", async () => {
    const credential = await resolveCopilotCredential(sources({
      env: { GH_TOKEN: "t", GH_HOST: "ghes.example", COPILOT_GH_HOST: "acme.ghe.com" },
    }));
    expect(credential?.host).toBe("https://acme.ghe.com");
  });

  it("reads the last login from the OS keychain", async () => {
    const readSecret = vi.fn(async () => "gho_stored\n");
    const credential = await resolveCopilotCredential(sources({
      readConfig: () => `// comment the CLI writes\n${config}`,
      readSecret,
    }));
    expect(readSecret).toHaveBeenCalledWith("copilot-cli", "https://github.com:octocat");
    expect(credential).toEqual({ token: "gho_stored", host: HOST, source: "keychain" });
  });

  it("falls back to the plaintext token store", async () => {
    const credential = await resolveCopilotCredential(sources({
      readConfig: () => JSON.stringify({
        last_logged_in_user: { host: HOST, login: "octocat" },
        copilot_tokens: { "https://github.com:octocat": "gho_plain" },
      }),
    }));
    expect(credential).toEqual({ token: "gho_plain", host: HOST, source: "config" });
  });

  it("lets a stored login beat the GITHUB_TOKEN Codespaces injects", async () => {
    const env = { CODESPACES: "true", GITHUB_TOKEN: "ghu_injected" };
    expect(await resolveCopilotCredential(sources({ env, readSecret: async () => "gho_stored" })))
      .toEqual({ token: "gho_stored", host: HOST, source: "keychain" });
    expect(await resolveCopilotCredential(sources({ env, readGhToken: async () => "gho_gh" })))
      .toEqual({ token: "ghu_injected", host: HOST, source: "GITHUB_TOKEN" });
  });

  it("still honours explicitly set tokens in Codespaces", async () => {
    const stored = { readSecret: async () => "gho_stored" };
    expect(await resolveCopilotCredential(sources({
      ...stored,
      env: { CODESPACES: "true", GITHUB_TOKEN: "ghu_mine" },
      explicitEnv: new Set(["GITHUB_TOKEN"]),
    }))).toMatchObject({ token: "ghu_mine", source: "GITHUB_TOKEN" });
    expect(await resolveCopilotCredential(sources({
      ...stored,
      env: { CODESPACES: "true", GITHUB_TOKEN: "ghu_injected", GH_TOKEN: "gho_exported" },
    }))).toMatchObject({ token: "gho_exported", source: "GH_TOKEN" });
  });

  it("honours a GITHUB_TOKEN exported over the one Codespaces injected", async () => {
    const env = { CODESPACES: "true", GITHUB_TOKEN: "ghu_mine" };
    const stored = { readSecret: async () => "gho_stored" };
    expect(await resolveCopilotCredential(sources({ ...stored, env, injectedGithubTokens: () => ["ghu_injected"] })))
      .toMatchObject({ token: "ghu_mine", source: "GITHUB_TOKEN" });
    expect(await resolveCopilotCredential(sources({ ...stored, env, injectedGithubTokens: () => ["ghu_mine"] })))
      .toMatchObject({ token: "gho_stored", source: "keychain" });
  });

  it("falls back to the GitHub CLI token for the target host", async () => {
    const readGhToken = vi.fn(async () => "gho_gh\n");
    expect(await resolveCopilotCredential(sources({ readConfig: () => null, readGhToken })))
      .toEqual({ token: "gho_gh", host: HOST, source: "gh" });
    expect(readGhToken).toHaveBeenLastCalledWith("github.com");

    await resolveCopilotCredential(sources({ env: { GH_HOST: "acme.ghe.com" }, readGhToken }));
    expect(readGhToken).toHaveBeenLastCalledWith("acme.ghe.com");

    readGhToken.mockClear();
    await resolveCopilotCredential(sources({ readSecret: async () => "gho_stored", readGhToken }));
    expect(readGhToken).not.toHaveBeenCalled();
  });

  it("only uses a stored login for the overriding host", async () => {
    const multi = JSON.stringify({
      lastLoggedInUser: { host: "https://ghes.example", login: "octo-ghes" },
      loggedInUsers: [
        { host: "https://ghes.example", login: "octo-ghes" },
        { host: HOST, login: "octocat" },
      ],
    });
    const readSecret = vi.fn(async (_service: string, account: string) => `gho_${account.split(":").at(-1)}`);
    expect(await resolveCopilotCredential(sources({ readConfig: () => multi, readSecret })))
      .toEqual({ token: "gho_octo-ghes", host: "https://ghes.example", source: "keychain" });
    expect(await resolveCopilotCredential(sources({
      readConfig: () => multi, readSecret, env: { GH_HOST: "ghes.example", COPILOT_GH_HOST: "github.com" },
    }))).toEqual({ token: "gho_octocat", host: HOST, source: "keychain" });

    const readGhToken = vi.fn(async () => "gho_gh");
    expect(await resolveCopilotCredential(sources({
      readConfig: () => multi, readSecret, readGhToken, env: { COPILOT_GH_HOST: "acme.ghe.com" },
    }))).toEqual({ token: "gho_gh", host: "https://acme.ghe.com", source: "gh" });
    expect(readGhToken).toHaveBeenCalledWith("acme.ghe.com");
  });

  it("skips classic PATs the way an interactive CLI does", async () => {
    expect(await resolveCopilotCredential(sources({
      env: { COPILOT_GITHUB_TOKEN: "ghp_classic", GH_TOKEN: "github_pat_fine" },
    }))).toMatchObject({ token: "github_pat_fine", source: "GH_TOKEN" });
    expect(await resolveCopilotCredential(sources({
      env: { GITHUB_TOKEN: "ghp_classic" },
      readSecret: async () => "gho_stored",
    }))).toMatchObject({ token: "gho_stored", source: "keychain" });
    expect(await resolveCopilotCredential(sources({
      env: { GH_TOKEN: "ghp_classic" },
      readGhToken: async () => "ghp_also_classic",
    }))).toBeNull();
  });

  it("returns null when nobody is signed in", async () => {
    expect(await resolveCopilotCredential(sources({ readConfig: () => null }))).toBeNull();
    expect(await resolveCopilotCredential(sources())).toBeNull();
    expect(await resolveCopilotCredential(sources({ readGhToken: async () => null }))).toBeNull();
  });
});

describe("readCopilotUsage", () => {
  it("reports a missing CLI and a missing login", async () => {
    const fetchImpl = respond(200, BUSINESS_USER);
    expect((await readCopilotUsage({ binary: null, credential: async () => null, fetch: fetchImpl })).usage.status)
      .toBe("not_installed");
    expect((await readCopilotUsage({ binary: "/bin/copilot", credential: async () => null, fetch: fetchImpl })).usage.status)
      .toBe("unauthenticated");
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
