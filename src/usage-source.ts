import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { PROFILE } from "./agent-entry.js";
import type { CopilotUsageReading } from "./copilot-usage.js";
import {
  usageFetchMethod,
  usageListMethod,
  usageMeasurementSchema,
  usageSourceRpcContract,
  type UsageMeasurement,
} from "./usage-contract.js";

export const CACHE_TTL_MS = 60_000;

type LocalHost = { id: string; name: string };

/**
 * Publishes GitHub Copilot quota through bb's `provider-usage.v1` contract so
 * the Provider usage panel and other consumers can show it. The credentials
 * live with the Copilot CLI on the machine this plugin runs on, so the only
 * resource is the bb server's own host.
 */
export function registerUsageSource(
  bb: Pick<BbPluginApi, "rpc" | "sdk">,
  read: () => Promise<CopilotUsageReading>,
  now: () => number = Date.now,
) {
  let cached: UsageMeasurement | null = null;
  let pending: { refresh: boolean; promise: Promise<UsageMeasurement> } | null = null;

  async function localHost(): Promise<LocalHost | null> {
    const { primaryHostId } = await bb.sdk.system.config();
    if (!primaryHostId) return null;
    const hosts = await bb.sdk.hosts.list();
    const host = hosts.find((candidate) => candidate.id === primaryHostId);
    return host ? { id: host.id, name: host.name } : null;
  }

  const resourceId = (hostId: string) => JSON.stringify([hostId, PROFILE.providerId]);

  async function load(refresh: boolean): Promise<UsageMeasurement> {
    const previous = cached;
    if (
      !refresh &&
      previous?.usage.status === "ok" &&
      previous.observedAt !== null &&
      now() - previous.observedAt < CACHE_TTL_MS
    ) {
      return previous;
    }
    let reading: CopilotUsageReading;
    try {
      reading = await read();
    } catch (error) {
      reading = {
        accountKey: null,
        usage: {
          status: "error",
          plan: null,
          accountEmail: null,
          planLabel: null,
          message: `Copilot quota could not be collected: ${error instanceof Error ? error.message : String(error)}`,
        },
      };
    }
    const ok = reading.usage.status === "ok";
    const value = usageMeasurementSchema.parse({
      // Only a failed read keeps the last known account; any other result
      // speaks for the current credential, whose identity may be unknown.
      accountKey: reading.usage.status === "error"
        ? (reading.accountKey ?? previous?.accountKey ?? null)
        : reading.accountKey,
      observedAt: ok ? now() : (previous?.observedAt ?? null),
      usage: reading.usage,
    });
    cached = value;
    return value;
  }

  async function collect(refresh: boolean): Promise<UsageMeasurement> {
    if (pending) {
      if (!refresh || pending.refresh) return pending.promise;
      await pending.promise.catch(() => undefined);
      return collect(refresh);
    }
    const current = { refresh, promise: load(refresh).finally(() => { pending = null; }) };
    pending = current;
    return current.promise;
  }

  bb.rpc.register(
    usageSourceRpcContract,
    {
      async [usageListMethod]() {
        const host = await localHost();
        if (host === null) return { resources: [] };
        return {
          resources: [{
            id: resourceId(host.id),
            accountKey: cached?.accountKey ?? null,
            providerId: PROFILE.providerId,
            label: PROFILE.displayName,
            scope: { kind: "host" as const, hostId: host.id, hostName: host.name },
          }],
        };
      },
      async [usageFetchMethod]({ resourceId: requested, refresh }) {
        const host = await localHost();
        if (host === null || requested !== resourceId(host.id)) {
          throw new Error("Usage resource no longer exists.");
        }
        return collect(refresh);
      },
    },
    {
      experimental_discoverable: true,
      experimental_description:
        "GitHub Copilot premium-request, chat, and completion quota for the Copilot CLI login on the bb server's machine. Inventory reads metadata only.",
    },
  );

  return { collect };
}
