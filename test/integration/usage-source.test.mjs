import assert from 'node:assert/strict';
import { describe, it, mock } from 'node:test';
import { usageFetchMethod, usageListMethod } from '../../src/usage-contract.ts';
import { CACHE_TTL_MS, registerUsageSource } from '../../src/usage-source.ts';

const RESOURCE_ID = JSON.stringify(['host_local', 'acp-gh-copilot']);

const OK = {
  accountKey: 'github.com:copilot-user:1',
  usage: { status: 'ok', plan: null, accountEmail: null, planLabel: 'Business', windows: [] },
};

function fakeBb(primaryHostId = 'host_local') {
  let handlers = {};
  let options;
  const bb = {
    rpc: {
      register: (_contract, registered, registerOptions) => {
        handlers = registered;
        options = registerOptions;
      },
    },
    sdk: {
      system: { config: async () => ({ primaryHostId }) },
      hosts: {
        list: async () => [
          { id: 'host_remote', name: 'Laptop' },
          { id: 'host_local', name: 'Mac Studio' },
        ],
      },
    },
  };
  return {
    bb,
    call: (method, input) => handlers[method](input),
    options: () => options,
  };
}

describe('registerUsageSource', () => {
  it("registers a discoverable source listing only the server's host", async () => {
    const { bb, call, options } = fakeBb();
    registerUsageSource(bb, async () => OK);
    assert.equal(options().experimental_discoverable, true);
    assert.deepEqual(await call(usageListMethod, {}), {
      resources: [
        {
          id: RESOURCE_ID,
          accountKey: null,
          providerId: 'acp-gh-copilot',
          label: 'GitHub Copilot',
          scope: { kind: 'host', hostId: 'host_local', hostName: 'Mac Studio' },
        },
      ],
    });
  });

  it('lists nothing when the server host is unknown', async () => {
    const { bb, call } = fakeBb(null);
    registerUsageSource(bb, async () => OK);
    assert.deepEqual(await call(usageListMethod, {}), { resources: [] });
  });

  it('caches a successful reading and refreshes on request', async () => {
    const { bb, call } = fakeBb();
    let clock = 1_000;
    const read = mock.fn(async () => OK);
    registerUsageSource(bb, read, () => clock);

    const first = await call(usageFetchMethod, { resourceId: RESOURCE_ID, refresh: false });
    assert.equal(first.accountKey, OK.accountKey);
    assert.equal(first.observedAt, 1_000);
    assert.equal(first.usage.status, 'ok');
    await call(usageFetchMethod, { resourceId: RESOURCE_ID, refresh: false });
    assert.equal(read.mock.callCount(), 1);

    await call(usageFetchMethod, { resourceId: RESOURCE_ID, refresh: true });
    assert.equal(read.mock.callCount(), 2);

    clock += CACHE_TTL_MS;
    await call(usageFetchMethod, { resourceId: RESOURCE_ID, refresh: false });
    assert.equal(read.mock.callCount(), 3);

    const listed = await call(usageListMethod, {});
    assert.equal(listed.resources[0].accountKey, OK.accountKey);
  });

  it('keeps the last observation time when a later read fails', async () => {
    const { bb, call } = fakeBb();
    const read = mock.fn(async () => OK);
    read.mock.mockImplementationOnce(async () => {
      throw new Error('boom');
    }, 1);
    registerUsageSource(bb, read, () => 5);
    await call(usageFetchMethod, { resourceId: RESOURCE_ID, refresh: true });
    assert.deepEqual(await call(usageFetchMethod, { resourceId: RESOURCE_ID, refresh: true }), {
      accountKey: OK.accountKey,
      observedAt: 5,
      usage: {
        status: 'error',
        plan: null,
        accountEmail: null,
        planLabel: null,
        message: 'Copilot quota could not be collected: boom',
      },
    });
  });

  it('reports a first read that fails without an observation time or account', async () => {
    const { bb, call } = fakeBb();
    registerUsageSource(
      bb,
      () => Promise.reject('offline'),
      () => 5
    );
    assert.deepEqual(await call(usageFetchMethod, { resourceId: RESOURCE_ID, refresh: true }), {
      accountKey: null,
      observedAt: null,
      usage: {
        status: 'error',
        plan: null,
        accountEmail: null,
        planLabel: null,
        message: 'Copilot quota could not be collected: offline',
      },
    });
  });

  it('keeps the account a failed read names over the previous one', async () => {
    const { bb, call } = fakeBb();
    const read = mock.fn(async () => OK);
    read.mock.mockImplementationOnce(
      async () => ({
        accountKey: 'github.com:copilot-user:2',
        usage: {
          status: 'error',
          plan: null,
          accountEmail: null,
          planLabel: null,
          message: 'GitHub returned HTTP 500 for Copilot quota.',
        },
      }),
      1
    );
    registerUsageSource(bb, read, () => 5);
    await call(usageFetchMethod, { resourceId: RESOURCE_ID, refresh: true });
    const failed = await call(usageFetchMethod, { resourceId: RESOURCE_ID, refresh: true });
    assert.equal(failed.accountKey, 'github.com:copilot-user:2');
    assert.equal(failed.observedAt, 5);
  });

  it('does not carry an account key over to a successful anonymous read', async () => {
    const { bb, call } = fakeBb();
    const read = mock.fn(async () => OK);
    read.mock.mockImplementationOnce(async () => ({ ...OK, accountKey: null }), 1);
    registerUsageSource(bb, read, () => 5);
    await call(usageFetchMethod, { resourceId: RESOURCE_ID, refresh: true });
    const second = await call(usageFetchMethod, { resourceId: RESOURCE_ID, refresh: true });
    assert.equal(second.accountKey, null);
    assert.equal(second.usage.status, 'ok');
  });

  it('rejects resources it did not list', async () => {
    const { bb, call } = fakeBb();
    registerUsageSource(bb, async () => OK);
    await assert.rejects(
      call(usageFetchMethod, {
        resourceId: JSON.stringify(['host_remote', 'acp-gh-copilot']),
        refresh: false,
      }),
      { message: 'Usage resource no longer exists.' }
    );
  });
});
