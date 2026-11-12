import assert from 'node:assert/strict';
import { describe, it, mock } from 'node:test';
import {
  apiBaseUrl,
  fetchCopilotUsage,
  parseCopilotUser,
  readCopilotUsage,
  resolveCopilotCredential,
} from '../../src/copilot-usage.ts';
import { usageMeasurementSchema } from '../../src/usage-contract.ts';

const HOST = 'https://github.com';

const BUSINESS_USER = {
  id: 161513220,
  login: 'octocat',
  copilot_plan: 'business',
  quota_reset_date: '2026-11-01',
  quota_reset_date_utc: '2026-11-01T00:00:00.000Z',
  quota_snapshots: {
    chat: { percent_remaining: 100, unlimited: true, quota_id: 'chat' },
    completions: { percent_remaining: 100, unlimited: true, quota_id: 'completions' },
    premium_interactions: {
      percent_remaining: 95.3,
      unlimited: false,
      overage_permitted: true,
      entitlement: 60000,
      remaining: 57228,
      quota_id: 'premium_interactions',
    },
  },
};

function respond(status, body = {}) {
  return mock.fn(async () => ({
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  }));
}

function okUsage(reading) {
  assert.equal(reading.usage.status, 'ok');
  return reading.usage;
}

function windows(reading, ...fields) {
  return okUsage(reading).windows.map((w) => fields.map((field) => w[field]));
}

function lastArgs(fn) {
  return fn.mock.calls.at(-1).arguments;
}

function calledWith(fn, ...expected) {
  assert.ok(
    fn.mock.calls.some((call) => {
      try {
        assert.deepStrictEqual(call.arguments, expected);
        return true;
      } catch {
        return false;
      }
    }),
    `expected a call with ${JSON.stringify(expected)}`
  );
}

describe('parseCopilotUser', () => {
  it('reports premium requests and skips unlimited quotas', () => {
    const reading = parseCopilotUser(BUSINESS_USER, HOST);
    assert.equal(reading.accountKey, 'github.com:copilot-user:161513220');
    assert.deepEqual(reading.usage, {
      status: 'ok',
      plan: { id: 'business', multiplier: null },
      accountEmail: null,
      planLabel: 'Business',
      windows: [
        {
          kind: 'custom',
          id: 'premium_interactions',
          label: 'Premium requests',
          usedPercent: 4.7,
          resetsAt: '2026-11-01T00:00:00.000Z',
          model: null,
          cost: null,
        },
      ],
    });
    assert.equal(usageMeasurementSchema.safeParse({ ...reading, observedAt: 1 }).success, true);
  });

  it('reports chat and completion snapshot limits and labels individual plans', () => {
    const reading = parseCopilotUser(
      {
        id: 1,
        copilot_plan: 'individual',
        quota_snapshots: {
          chat: { percent_remaining: 40, unlimited: false },
          completions: { percent_remaining: 90, unlimited: false },
          premium_interactions: { percent_remaining: -12.5, unlimited: false },
        },
      },
      HOST
    );
    assert.equal(okUsage(reading).planLabel, 'Pro');
    assert.deepEqual(windows(reading, 'id', 'usedPercent', 'resetsAt'), [
      ['premium_interactions', 112.5, null],
      ['chat', 60, null],
      ['completions', 10, null],
    ]);
  });

  it('labels Free by access SKU and token-billed premium quota as AI credits', () => {
    const free = okUsage(
      parseCopilotUser(
        { copilot_plan: 'individual', access_type_sku: 'free_limited_copilot' },
        HOST
      )
    );
    assert.deepEqual(free.plan, { id: 'free', multiplier: null });
    assert.equal(free.planLabel, 'Free');
    const educational = okUsage(
      parseCopilotUser(
        { copilot_plan: 'individual', access_type_sku: 'free_educational_quota' },
        HOST
      )
    );
    assert.equal(educational.planLabel, 'Free');

    const credits = parseCopilotUser(
      {
        copilot_plan: 'business',
        token_based_billing: true,
        quota_snapshots: { premium_interactions: { percent_remaining: 70, unlimited: false } },
      },
      HOST
    );
    assert.deepEqual(windows(credits, 'id', 'label', 'usedPercent'), [
      ['premium_interactions', 'AI credits', 30],
    ]);

    const snapshotMarked = parseCopilotUser(
      {
        quota_snapshots: {
          premium_models: { percent_remaining: 40, unlimited: false, token_based_billing: true },
        },
      },
      HOST
    );
    assert.deepEqual(windows(snapshotMarked, 'id', 'label', 'usedPercent'), [
      ['premium_interactions', 'AI credits', 60],
    ]);
  });

  it('degrades to no windows rather than a fake 0%', () => {
    const reading = parseCopilotUser(
      { quota_snapshots: { premium_interactions: { unlimited: false } } },
      HOST
    );
    assert.deepEqual(reading, {
      accountKey: null,
      usage: { status: 'ok', plan: null, accountEmail: null, planLabel: null, windows: [] },
    });
  });

  it('reads legacy Free allowances, normalizes the reset date and treats zero entitlement as none', () => {
    const reading = parseCopilotUser(
      {
        id: 2,
        copilot_plan: 'free',
        limited_user_quotas: { chat: 10, completions: 1500 },
        monthly_quotas: { chat: 50, completions: '2000' },
        limited_user_reset_date: '2026-11-05',
        quota_snapshots: {
          premium_interactions: { percent_remaining: 0, unlimited: false, entitlement: 0 },
        },
      },
      HOST
    );
    assert.equal(okUsage(reading).planLabel, 'Free');
    assert.deepEqual(windows(reading, 'id', 'usedPercent', 'resetsAt'), [
      ['chat', 80, '2026-11-05T00:00:00.000Z'],
      ['completions', 25, '2026-11-05T00:00:00.000Z'],
    ]);
    assert.equal(usageMeasurementSchema.safeParse({ ...reading, observedAt: 1 }).success, true);
  });

  it('prefers snapshots over legacy fields and per-snapshot reset times', () => {
    const reading = parseCopilotUser(
      {
        quota_reset_date_utc: '2026-11-01T00:00:00.000Z',
        limited_user_quotas: { chat: 0 },
        monthly_quotas: { chat: 50 },
        quota_snapshots: {
          chat: { percent_remaining: 70, unlimited: false, quota_reset_at: '2026-10-06T12:00:00Z' },
        },
      },
      HOST
    );
    assert.deepEqual(windows(reading, 'id', 'usedPercent', 'resetsAt'), [
      ['chat', 30, '2026-10-06T12:00:00.000Z'],
    ]);
  });

  it('reads premium_models before premium_interactions', () => {
    const reading = parseCopilotUser(
      {
        quota_snapshots: {
          premium_models: { percent_remaining: 20, unlimited: false, reset_date: '2026-11-01' },
          premium_interactions: { percent_remaining: 90, unlimited: false },
        },
      },
      HOST
    );
    assert.deepEqual(windows(reading, 'id', 'label', 'usedPercent', 'resetsAt'), [
      ['premium_interactions', 'Premium requests', 80, '2026-11-01T00:00:00.000Z'],
    ]);
  });

  it('derives the percentage from remaining and entitlement when it is missing', () => {
    const reading = parseCopilotUser(
      {
        copilot_plan: null,
        quota_snapshots: {
          premium_interactions: {
            unlimited: false,
            entitlement: 300,
            remaining: 75,
            percent_remaining: null,
          },
          chat: { unlimited: false, entitlement: '50', quota_remaining: 50 },
          completions: { unlimited: false, remaining: 10 },
        },
      },
      HOST
    );
    assert.deepEqual(windows(reading, 'id', 'usedPercent'), [
      ['premium_interactions', 75],
      ['chat', 0],
    ]);
  });

  it('reports an exhausted pooled entitlement instead of hiding it', () => {
    const reading = parseCopilotUser(
      {
        quota_reset_date_utc: '2026-11-01T00:00:00.000Z',
        quota_snapshots: {
          premium_models: { unlimited: true, has_quota: false, percent_remaining: 100 },
          chat: { unlimited: true, has_quota: true, percent_remaining: 100 },
          completions: { entitlement: -1, percent_remaining: 100 },
        },
      },
      HOST
    );
    assert.deepEqual(windows(reading, 'id', 'usedPercent', 'resetsAt'), [
      ['premium_interactions', 100, '2026-11-01T00:00:00.000Z'],
    ]);
  });

  it('skips a null premium_models alias and keeps the port in account keys', () => {
    const reading = parseCopilotUser(
      {
        id: 7,
        quota_snapshots: {
          premium_models: null,
          premium_interactions: { unlimited: false, percent_remaining: 40 },
        },
      },
      'https://git.example:8443'
    );
    assert.equal(reading.accountKey, 'git.example:8443:copilot-user:7');
    assert.deepEqual(windows(reading, 'id', 'usedPercent'), [['premium_interactions', 60]]);
  });

  it('treats null quota containers and ids as absent', () => {
    const reading = parseCopilotUser(
      {
        id: null,
        quota_snapshots: null,
        limited_user_quotas: { chat: 25 },
        monthly_quotas: { chat: 50 },
      },
      HOST
    );
    assert.equal(reading.accountKey, null);
    assert.deepEqual(windows(reading, 'id', 'usedPercent'), [['chat', 50]]);
    assert.equal(
      parseCopilotUser({ limited_user_quotas: null, monthly_quotas: null }, HOST).usage.status,
      'ok'
    );
  });

  it('counts paid overage beyond the allowance', () => {
    const reading = parseCopilotUser(
      {
        quota_snapshots: {
          premium_interactions: {
            unlimited: false,
            entitlement: 100,
            percent_remaining: 0,
            overage_count: 25,
          },
          chat: { unlimited: false, entitlement: '50', overage_count: 5, has_quota: false },
        },
      },
      HOST
    );
    assert.deepEqual(windows(reading, 'id', 'usedPercent'), [
      ['premium_interactions', 125],
      ['chat', 110],
    ]);
  });

  it('reports a finite snapshot without quota as exhausted', () => {
    const reading = parseCopilotUser(
      {
        quota_snapshots: {
          premium_interactions: { unlimited: false, entitlement: 300, has_quota: false },
          chat: { unlimited: false, entitlement: 50, has_quota: false, percent_remaining: 20 },
          completions: { unlimited: false, entitlement: 0, has_quota: false },
        },
      },
      HOST
    );
    assert.deepEqual(windows(reading, 'id', 'usedPercent'), [
      ['premium_interactions', 100],
      ['chat', 100],
    ]);
  });

  it('reads epoch-second reset times and never drops a quota over its reset field', () => {
    const reading = parseCopilotUser(
      {
        quota_reset_date_utc: false,
        quota_snapshots: {
          premium_interactions: {
            percent_remaining: 75,
            unlimited: false,
            quota_reset_at: 1_791_201_600,
          },
          chat: { percent_remaining: 50, unlimited: false, quota_reset_at: { weird: true } },
        },
      },
      HOST
    );
    assert.deepEqual(windows(reading, 'id', 'usedPercent', 'resetsAt'), [
      ['premium_interactions', 25, '2026-10-05T12:00:00.000Z'],
      ['chat', 50, null],
    ]);
  });

  it('rejects a non-object payload', () => {
    assert.equal(parseCopilotUser('nope', HOST).usage.status, 'error');
  });
});

describe('apiBaseUrl', () => {
  it('maps dotcom, GHE.com, and GHES hosts', () => {
    assert.equal(apiBaseUrl('https://github.com'), 'https://api.github.com');
    assert.equal(apiBaseUrl('https://acme.ghe.com'), 'https://api.acme.ghe.com');
    assert.equal(apiBaseUrl('https://git.acme.test'), 'https://git.acme.test/api/v3');
  });
});

describe('fetchCopilotUsage', () => {
  const credential = { token: 'gho_test', host: HOST, source: 'keychain' };

  it('calls the Copilot user endpoint with the token', async () => {
    const fetchImpl = respond(200, BUSINESS_USER);
    const reading = await fetchCopilotUsage(credential, fetchImpl);
    assert.equal(reading.usage.status, 'ok');
    const [url, init] = lastArgs(fetchImpl);
    assert.equal(url, 'https://api.github.com/copilot_internal/user');
    assert.equal(init.headers.Authorization, 'token gho_test');
  });

  it('maps HTTP statuses to usage states', async () => {
    assert.equal((await fetchCopilotUsage(credential, respond(401))).usage.status, 'expired');
    assert.partialDeepStrictEqual((await fetchCopilotUsage(credential, respond(404))).usage, {
      status: 'error',
      message: 'GitHub returned HTTP 404 for Copilot quota. The token may lack Copilot access.',
    });
    assert.partialDeepStrictEqual((await fetchCopilotUsage(credential, respond(501))).usage, {
      status: 'ok',
      windows: [],
    });
    assert.partialDeepStrictEqual((await fetchCopilotUsage(credential, respond(500))).usage, {
      status: 'error',
      message: 'GitHub returned HTTP 500 for Copilot quota.',
    });
  });

  it('reports network failures without throwing', async () => {
    const reading = await fetchCopilotUsage(
      credential,
      mock.fn(async () => {
        throw new Error('offline');
      })
    );
    assert.equal(reading.usage.status, 'error');
    assert.match(reading.usage.message, /offline/);
  });

  it('reports a non-Error rejection and an unreadable body as errors', async () => {
    const thrown = await fetchCopilotUsage(
      credential,
      mock.fn(async () => Promise.reject('socket hang up'))
    );
    assert.equal(thrown.usage.message, 'Could not reach GitHub for Copilot quota: socket hang up');
    const unreadable = await fetchCopilotUsage(
      credential,
      mock.fn(async () => ({
        ok: true,
        status: 200,
        json: async () => {
          throw new SyntaxError('Unexpected token');
        },
      }))
    );
    assert.equal(unreadable.usage.message, 'GitHub returned an unreadable Copilot quota response.');
  });
});

describe('resolveCopilotCredential', () => {
  const config = JSON.stringify({ lastLoggedInUser: { host: HOST, login: 'octocat' } });

  function sources(overrides = {}) {
    return { env: {}, readConfig: () => config, readSecret: async () => null, ...overrides };
  }

  it('prefers env tokens in Copilot CLI order', async () => {
    const credential = await resolveCopilotCredential(
      sources({
        env: { GITHUB_TOKEN: 'c', GH_TOKEN: 'b', COPILOT_GITHUB_TOKEN: 'a' },
        readSecret: async () => 'stored',
      })
    );
    assert.deepEqual(credential, { token: 'a', host: HOST, source: 'COPILOT_GITHUB_TOKEN' });
  });

  it('targets COPILOT_GH_HOST over GH_HOST for env tokens', async () => {
    const credential = await resolveCopilotCredential(
      sources({ env: { GH_TOKEN: 't', GH_HOST: 'ghes.example', COPILOT_GH_HOST: 'acme.ghe.com' } })
    );
    assert.equal(credential?.host, 'https://acme.ghe.com');
  });

  it('reads the last login from the OS keychain, past the comment the CLI writes', async () => {
    const readSecret = mock.fn(async () => 'gho_stored\n');
    const credential = await resolveCopilotCredential(
      sources({ readConfig: () => `// comment the CLI writes\n${config}`, readSecret })
    );
    calledWith(readSecret, 'copilot-cli', 'https://github.com:octocat');
    assert.deepEqual(credential, { token: 'gho_stored', host: HOST, source: 'keychain' });
  });

  it('falls back to the plaintext token store', async () => {
    const credential = await resolveCopilotCredential(
      sources({
        readConfig: () =>
          JSON.stringify({
            last_logged_in_user: { host: HOST, login: 'octocat' },
            copilot_tokens: { 'https://github.com:octocat': 'gho_plain' },
          }),
      })
    );
    assert.deepEqual(credential, { token: 'gho_plain', host: HOST, source: 'config' });
  });

  it('lets a stored login beat the GITHUB_TOKEN Codespaces injects', async () => {
    const env = { CODESPACES: 'true', GITHUB_TOKEN: 'ghu_injected' };
    assert.deepEqual(
      await resolveCopilotCredential(sources({ env, readSecret: async () => 'gho_stored' })),
      { token: 'gho_stored', host: HOST, source: 'keychain' }
    );
    assert.deepEqual(
      await resolveCopilotCredential(sources({ env, readGhToken: async () => 'gho_gh' })),
      { token: 'ghu_injected', host: HOST, source: 'GITHUB_TOKEN' }
    );
  });

  it('still honours explicitly set tokens in Codespaces', async () => {
    const stored = { readSecret: async () => 'gho_stored' };
    assert.partialDeepStrictEqual(
      await resolveCopilotCredential(
        sources({
          ...stored,
          env: { CODESPACES: 'true', GITHUB_TOKEN: 'ghu_mine' },
          explicitEnv: new Set(['GITHUB_TOKEN']),
        })
      ),
      { token: 'ghu_mine', source: 'GITHUB_TOKEN' }
    );
    assert.partialDeepStrictEqual(
      await resolveCopilotCredential(
        sources({
          ...stored,
          env: { CODESPACES: 'true', GITHUB_TOKEN: 'ghu_injected', GH_TOKEN: 'gho_exported' },
        })
      ),
      { token: 'gho_exported', source: 'GH_TOKEN' }
    );
  });

  it('honours a GITHUB_TOKEN exported over the one Codespaces injected', async () => {
    const env = { CODESPACES: 'true', GITHUB_TOKEN: 'ghu_mine' };
    const stored = { readSecret: async () => 'gho_stored' };
    assert.partialDeepStrictEqual(
      await resolveCopilotCredential(
        sources({ ...stored, env, injectedGithubTokens: () => ['ghu_injected'] })
      ),
      { token: 'ghu_mine', source: 'GITHUB_TOKEN' }
    );
    assert.partialDeepStrictEqual(
      await resolveCopilotCredential(
        sources({ ...stored, env, injectedGithubTokens: () => ['ghu_mine'] })
      ),
      { token: 'gho_stored', source: 'keychain' }
    );
  });

  it('falls back to the GitHub CLI token for the target host', async () => {
    const readGhToken = mock.fn(async () => 'gho_gh\n');
    assert.deepEqual(
      await resolveCopilotCredential(sources({ readConfig: () => null, readGhToken })),
      { token: 'gho_gh', host: HOST, source: 'gh' }
    );
    assert.deepEqual(lastArgs(readGhToken), ['github.com']);

    await resolveCopilotCredential(sources({ env: { GH_HOST: 'acme.ghe.com' }, readGhToken }));
    assert.deepEqual(lastArgs(readGhToken), ['acme.ghe.com']);

    readGhToken.mock.resetCalls();
    await resolveCopilotCredential(sources({ readSecret: async () => 'gho_stored', readGhToken }));
    assert.equal(readGhToken.mock.callCount(), 0);
  });

  it('only uses a stored login for the overriding host', async () => {
    const multi = JSON.stringify({
      lastLoggedInUser: { host: 'https://ghes.example', login: 'octo-ghes' },
      loggedInUsers: [
        { host: 'https://ghes.example', login: 'octo-ghes' },
        { host: HOST, login: 'octocat' },
      ],
    });
    const readSecret = mock.fn(async (_service, account) => `gho_${account.split(':').at(-1)}`);
    assert.deepEqual(
      await resolveCopilotCredential(sources({ readConfig: () => multi, readSecret })),
      { token: 'gho_octo-ghes', host: 'https://ghes.example', source: 'keychain' }
    );
    assert.deepEqual(
      await resolveCopilotCredential(
        sources({
          readConfig: () => multi,
          readSecret,
          env: { GH_HOST: 'ghes.example', COPILOT_GH_HOST: 'github.com' },
        })
      ),
      { token: 'gho_octocat', host: HOST, source: 'keychain' }
    );

    const readGhToken = mock.fn(async () => 'gho_gh');
    assert.deepEqual(
      await resolveCopilotCredential(
        sources({
          readConfig: () => multi,
          readSecret,
          readGhToken,
          env: { COPILOT_GH_HOST: 'acme.ghe.com' },
        })
      ),
      { token: 'gho_gh', host: 'https://acme.ghe.com', source: 'gh' }
    );
    calledWith(readGhToken, 'acme.ghe.com');
  });

  it('skips classic PATs the way an interactive CLI does', async () => {
    assert.partialDeepStrictEqual(
      await resolveCopilotCredential(
        sources({ env: { COPILOT_GITHUB_TOKEN: 'ghp_classic', GH_TOKEN: 'github_pat_fine' } })
      ),
      { token: 'github_pat_fine', source: 'GH_TOKEN' }
    );
    assert.partialDeepStrictEqual(
      await resolveCopilotCredential(
        sources({ env: { GITHUB_TOKEN: 'ghp_classic' }, readSecret: async () => 'gho_stored' })
      ),
      { token: 'gho_stored', source: 'keychain' }
    );
    assert.equal(
      await resolveCopilotCredential(
        sources({ env: { GH_TOKEN: 'ghp_classic' }, readGhToken: async () => 'ghp_also_classic' })
      ),
      null
    );
  });

  it('returns null when nobody is signed in', async () => {
    assert.equal(await resolveCopilotCredential(sources({ readConfig: () => null })), null);
    assert.equal(await resolveCopilotCredential(sources()), null);
    assert.equal(await resolveCopilotCredential(sources({ readGhToken: async () => null })), null);
  });
});

describe('readCopilotUsage', () => {
  it('reports a missing CLI and a missing login', async () => {
    const fetchImpl = respond(200, BUSINESS_USER);
    assert.equal(
      (await readCopilotUsage({ binary: null, credential: async () => null, fetch: fetchImpl }))
        .usage.status,
      'not_installed'
    );
    assert.equal(
      (
        await readCopilotUsage({
          binary: '/bin/copilot',
          credential: async () => null,
          fetch: fetchImpl,
        })
      ).usage.status,
      'unauthenticated'
    );
    assert.equal(fetchImpl.mock.callCount(), 0);
  });

  it('reports a credential lookup that fails as an error', async () => {
    const fetchImpl = respond(200, BUSINESS_USER);
    const failed = await readCopilotUsage({
      binary: '/bin/copilot',
      credential: async () => {
        throw new Error('keychain locked');
      },
      fetch: fetchImpl,
    });
    assert.equal(failed.usage.message, 'Could not read Copilot credentials: keychain locked');
    const rejected = await readCopilotUsage({
      binary: '/bin/copilot',
      credential: () => Promise.reject('denied'),
      fetch: fetchImpl,
    });
    assert.equal(rejected.usage.message, 'Could not read Copilot credentials: denied');
    assert.equal(fetchImpl.mock.callCount(), 0);
  });
});
