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

  it("reports chat and completion limits on Free and labels individual plans", () => {
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

  it("degrades to no windows rather than a fake 0%", () => {
    const reading = parseCopilotUser({ quota_snapshots: { premium_interactions: { unlimited: false } } }, HOST);
    expect(reading).toEqual({
      accountKey: null,
      usage: { status: "ok", plan: null, accountEmail: null, planLabel: null, windows: [] },
    });
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
