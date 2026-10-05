import { describe, expect, it, vi } from "vitest";
import type { CopilotUsageReading } from "./copilot-usage.js";
import { CACHE_TTL_MS, registerUsageSource } from "./usage-source.js";
import { usageFetchMethod, usageListMethod } from "./usage-contract.js";

type Handlers = Record<string, (input: never) => Promise<unknown>>;

const RESOURCE_ID = JSON.stringify(["host_local", "acp-gh-copilot"]);

const OK: CopilotUsageReading = {
  accountKey: "github.com:copilot-user:1",
  usage: { status: "ok", plan: null, accountEmail: null, planLabel: "Business", windows: [] },
};

function fakeBb(primaryHostId: string | null = "host_local") {
  let handlers: Handlers = {};
  let options: unknown;
  const bb = {
    rpc: {
      register: vi.fn((_contract: unknown, registered: Handlers, registerOptions: unknown) => {
        handlers = registered;
        options = registerOptions;
      }),
    },
    sdk: {
      system: { config: vi.fn(async () => ({ primaryHostId })) },
      hosts: {
        list: vi.fn(async () => [
          { id: "host_remote", name: "Laptop" },
          { id: "host_local", name: "Mac Studio" },
        ]),
      },
    },
  };
  return {
    bb: bb as never,
    call: (method: string, input: unknown) => handlers[method]!(input as never),
    options: () => options,
  };
}

describe("registerUsageSource", () => {
  it("registers a discoverable source listing only the server's host", async () => {
    const { bb, call, options } = fakeBb();
    registerUsageSource(bb, async () => OK);
    expect(options()).toMatchObject({ experimental_discoverable: true });
    expect(await call(usageListMethod, {})).toEqual({
      resources: [{
        id: RESOURCE_ID,
        accountKey: null,
        providerId: "acp-gh-copilot",
        label: "GitHub Copilot",
        scope: { kind: "host", hostId: "host_local", hostName: "Mac Studio" },
      }],
    });
  });

  it("lists nothing when the server host is unknown", async () => {
    const { bb, call } = fakeBb(null);
    registerUsageSource(bb, async () => OK);
    expect(await call(usageListMethod, {})).toEqual({ resources: [] });
  });

  it("caches a successful reading and refreshes on request", async () => {
    const { bb, call } = fakeBb();
    let clock = 1_000;
    const read = vi.fn(async () => OK);
    registerUsageSource(bb, read, () => clock);

    const first = await call(usageFetchMethod, { resourceId: RESOURCE_ID, refresh: false });
    expect(first).toMatchObject({ accountKey: OK.accountKey, observedAt: 1_000, usage: { status: "ok" } });
    await call(usageFetchMethod, { resourceId: RESOURCE_ID, refresh: false });
    expect(read).toHaveBeenCalledTimes(1);

    await call(usageFetchMethod, { resourceId: RESOURCE_ID, refresh: true });
    expect(read).toHaveBeenCalledTimes(2);

    clock += CACHE_TTL_MS;
    await call(usageFetchMethod, { resourceId: RESOURCE_ID, refresh: false });
    expect(read).toHaveBeenCalledTimes(3);

    expect(await call(usageListMethod, {})).toMatchObject({ resources: [{ accountKey: OK.accountKey }] });
  });

  it("keeps the last observation time when a later read fails", async () => {
    const { bb, call } = fakeBb();
    const read = vi.fn<() => Promise<CopilotUsageReading>>()
      .mockResolvedValueOnce(OK)
      .mockRejectedValueOnce(new Error("boom"));
    registerUsageSource(bb, read, () => 5);
    await call(usageFetchMethod, { resourceId: RESOURCE_ID, refresh: true });
    expect(await call(usageFetchMethod, { resourceId: RESOURCE_ID, refresh: true })).toEqual({
      accountKey: OK.accountKey,
      observedAt: 5,
      usage: {
        status: "error",
        plan: null,
        accountEmail: null,
        planLabel: null,
        message: "Copilot quota could not be collected: boom",
      },
    });
  });

  it("rejects resources it did not list", async () => {
    const { bb, call } = fakeBb();
    registerUsageSource(bb, async () => OK);
    await expect(call(usageFetchMethod, { resourceId: JSON.stringify(["host_remote", "acp-gh-copilot"]), refresh: false }))
      .rejects.toThrow("Usage resource no longer exists.");
  });
});
