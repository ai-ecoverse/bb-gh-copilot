import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { execFile } from "node:child_process";
import {
  accessSync,
  chmodSync,
  constants,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import {
  ACP_PLUGIN_ID,
  PROFILE,
  findOwnAgent,
  isObject,
  isOwnAgent,
  isRenamedAgent,
  managedAgent,
  parseCustomAgents,
  removeAgent,
  stringifyCustomAgents,
  upsertAgent,
  type CustomAgent,
  type JsonObject,
} from "./src/agent-entry.js";
import {
  readCopilotUsage,
  resolveCopilotCredential,
  type CopilotUsage,
} from "./src/copilot-usage.js";
import { registerUsageSource } from "./src/usage-source.js";

const SETTINGS_READY_ATTEMPTS = 10;
const SETTINGS_READY_DELAY_MS = 500;

function isExecutable(path: string): boolean {
  try {
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function findBinary(existing?: CustomAgent): string | null {
  if (typeof existing?.command === "string" && existing.command.includes(delimiter) && isExecutable(existing.command)) {
    return existing.command;
  }
  const names = process.platform === "win32"
    ? [`${PROFILE.binary}.exe`, `${PROFILE.binary}.cmd`, PROFILE.binary]
    : [PROFILE.binary];
  const directories = [
    ...(process.env.PATH ?? "").split(delimiter),
    join(homedir(), ".local", "bin"),
    join(homedir(), ".npm-global", "bin"),
    "/opt/homebrew/bin",
    "/usr/local/bin",
  ].filter(Boolean);
  for (const directory of new Set(directories)) {
    for (const name of names) {
      const candidate = join(directory, name);
      if (isExecutable(candidate)) return candidate;
    }
  }
  return null;
}

function readConfig(configPath: string): JsonObject {
  if (!existsSync(configPath)) return {};
  const parsed: unknown = JSON.parse(readFileSync(configPath, "utf8"));
  if (!isObject(parsed)) {
    throw new Error(`${configPath} must contain a JSON object; refusing to overwrite it`);
  }
  return parsed;
}

function writeAtomic(path: string, value: JsonObject): void {
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.${PROFILE.id}.${process.pid}.tmp`;
  try {
    writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    chmodSync(temporary, 0o600);
    renameSync(temporary, path);
  } finally {
    rmSync(temporary, { force: true });
  }
}

function readSecret(service: string, account: string): Promise<string | null> {
  const lookup: [string, string[]] | null = process.platform === "darwin"
    ? ["security", ["find-generic-password", "-s", service, "-a", account, "-w"]]
    : process.platform === "linux"
      ? ["secret-tool", ["lookup", "service", service, "account", account]]
      : null;
  if (lookup === null) return Promise.resolve(null);
  return new Promise((resolve) => {
    execFile(lookup[0], lookup[1], { timeout: 5_000, encoding: "utf8" }, (error, stdout) => {
      resolve(error ? null : stdout.trim() || null);
    });
  });
}

function readCopilotConfig(env: Record<string, string | undefined>): string | null {
  const configPath = join(env.COPILOT_HOME || join(homedir(), ".copilot"), "config.json");
  try {
    return readFileSync(configPath, "utf8");
  } catch {
    return null;
  }
}

function formatUsage(usage: CopilotUsage): string {
  if (usage.status === "not_installed") return `${PROFILE.binary} was not found. ${PROFILE.installHint}\n`;
  if (usage.status === "unauthenticated") return "Not signed in. Run `copilot login`.\n";
  if (usage.status === "expired") return "GitHub rejected the stored Copilot login. Run `copilot login` again.\n";
  if (usage.status === "error") return `${usage.message}\n`;
  const lines = [`Plan: ${usage.planLabel ?? "unknown"}`];
  if (usage.windows.length === 0) lines.push("No quota limits reported.");
  for (const window of usage.windows) {
    lines.push(`${window.label}: ${window.usedPercent}% used${window.resetsAt ? `, resets ${window.resetsAt}` : ""}`);
  }
  return `${lines.join("\n")}\n`;
}

function readLegacyAgents(dataDir: string): CustomAgent[] {
  const config = readConfig(join(dataDir, "config.json"));
  return Array.isArray(config.customAcpAgents) ? [...config.customAcpAgents] as CustomAgent[] : [];
}

function writeLegacyAgents(dataDir: string, agents: CustomAgent[]): boolean {
  const configPath = join(dataDir, "config.json");
  const config = readConfig(configPath);
  const current = Array.isArray(config.customAcpAgents) ? config.customAcpAgents as CustomAgent[] : [];
  if (JSON.stringify(current) === JSON.stringify(agents)) return false;
  if (agents.length === 0) delete config.customAcpAgents;
  else config.customAcpAgents = agents;
  writeAtomic(configPath, config);
  return true;
}

export default function plugin(bb: BbPluginApi) {
  async function dataDir(): Promise<string> {
    try {
      const config = await bb.sdk.system.config();
      if (config.dataDir.length > 0) return config.dataDir;
    } catch (error) {
      bb.log.warn(`Could not resolve bb data directory through the SDK: ${String(error)}`);
    }
    return process.env.BB_DATA_DIR ?? join(homedir(), ".bb");
  }

  async function readSettingAgents(): Promise<CustomAgent[] | null> {
    try {
      const settings = await bb.sdk.plugins.getSettings({ pluginId: ACP_PLUGIN_ID });
      return parseCustomAgents(settings.values.customAgents);
    } catch (error) {
      bb.log.warn(`Could not read ${ACP_PLUGIN_ID} customAgents: ${String(error)}`);
      return null;
    }
  }

  // At startup the settings read can lose the race with the ACP plugin's own
  // factory and answer 404. Falling back to the deprecated config.json array on
  // that answer would write legacy config on every fresh install, so wait for
  // the plugin to come up before deciding it is unavailable.
  async function readSettingAgentsWhenReady(): Promise<CustomAgent[] | null> {
    for (let attempt = 0; attempt < SETTINGS_READY_ATTEMPTS; attempt += 1) {
      const agents = await readSettingAgents();
      if (agents !== null) return agents;
      await new Promise((resolve) => setTimeout(resolve, SETTINGS_READY_DELAY_MS));
    }
    return readSettingAgents();
  }

  async function writeSettingAgents(agents: CustomAgent[]): Promise<boolean> {
    const serialized = agents.length === 0 ? "" : stringifyCustomAgents(agents);
    await bb.sdk.plugins.updateSettings({
      pluginId: ACP_PLUGIN_ID,
      values: { customAgents: serialized },
    });
    return true;
  }

  async function provision(waitForSettings = false): Promise<{ changed: boolean; binary: string }> {
    const root = await dataDir();
    const settingAgents = waitForSettings ? await readSettingAgentsWhenReady() : await readSettingAgents();
    const legacyAgents = readLegacyAgents(root);
    const existing = (settingAgents === null ? undefined : findOwnAgent(settingAgents))
      ?? findOwnAgent(legacyAgents);
    const binary = findBinary(existing);
    if (binary === null) throw new Error(`${PROFILE.binary} was not found. ${PROFILE.installHint}`);

    const managed = managedAgent(binary, existing);
    let changed = false;

    if (settingAgents !== null) {
      const next = upsertAgent(settingAgents, managed);
      if (next.changed) {
        await writeSettingAgents(next.agents);
        changed = true;
      }
    } else {
      const next = upsertAgent(legacyAgents, managed);
      if (next.changed && writeLegacyAgents(root, next.agents)) {
        await bb.sdk.system.reloadConfig();
        changed = true;
      }
      return { changed, binary };
    }

    const stripped = removeAgent(legacyAgents);
    if (stripped.changed && writeLegacyAgents(root, stripped.agents)) {
      await bb.sdk.system.reloadConfig();
      changed = true;
    }
    return { changed, binary };
  }

  async function unregister(): Promise<boolean> {
    const root = await dataDir();
    let changed = false;
    const settingAgents = await readSettingAgents();
    if (settingAgents !== null) {
      const next = removeAgent(settingAgents);
      if (next.changed) {
        await writeSettingAgents(next.agents);
        changed = true;
      }
    }
    const stripped = removeAgent(readLegacyAgents(root));
    if (stripped.changed && writeLegacyAgents(root, stripped.agents)) {
      await bb.sdk.system.reloadConfig();
      changed = true;
    }
    return changed;
  }

  async function currentEntry(): Promise<CustomAgent | undefined> {
    const settingAgents = await readSettingAgents();
    return (settingAgents === null ? undefined : findOwnAgent(settingAgents))
      ?? findOwnAgent(readLegacyAgents(await dataDir()));
  }

  const usage = registerUsageSource(bb, async () => {
    const entry = await currentEntry();
    // Copilot runs with the managed entry's env layered over the inherited
    // one, so a token configured there wins exactly as it does for the CLI.
    const agentEnv = isObject(entry?.env)
      ? Object.fromEntries(Object.entries(entry.env).filter((pair): pair is [string, string] => typeof pair[1] === "string"))
      : {};
    const env = { ...process.env, ...agentEnv };
    return readCopilotUsage({
      binary: findBinary(entry),
      credential: () => resolveCopilotCredential({ env, readConfig: () => readCopilotConfig(env), readSecret }),
      fetch: (input, init) => fetch(input, init),
    });
  });

  bb.background.service("provision", {
    async start() {
      try {
        const result = await provision(true);
        bb.log.info(
          result.changed
            ? `registered ${PROFILE.providerId} with ${result.binary}`
            : `${PROFILE.providerId} is already configured`,
        );
      } catch (error) {
        const message = String(error);
        bb.log.error(message);
        bb.status.needsConfiguration(message);
      }
    },
  });

  bb.cli.register({
    name: PROFILE.id,
    summary: `Manage the ${PROFILE.displayName} ACP provider.`,
    commands: [
      { name: "status", summary: "Check the CLI and bb provider registration", usage: `${PROFILE.id} status` },
      { name: "usage", summary: "Show Copilot premium-request and chat quota", usage: `${PROFILE.id} usage [--json]` },
      { name: "repair", summary: "Rewrite and reload the managed ACP configuration", usage: `${PROFILE.id} repair` },
      { name: "unregister", summary: "Remove this plugin's managed ACP configuration", usage: `${PROFILE.id} unregister` },
    ],
    async run(argv) {
      const command = argv[0] ?? "status";
      if (command === "repair") {
        try {
          const result = await provision();
          return { exitCode: 0, stdout: `${PROFILE.providerId}: ${result.changed ? "repaired" : "already up to date"}\nCLI: ${result.binary}\n` };
        } catch (error) {
          return { exitCode: 1, stderr: `${String(error)}\n` };
        }
      }
      if (command === "usage") {
        const measurement = await usage.collect(true);
        const ok = measurement.usage.status === "ok";
        if (argv.includes("--json")) {
          return { exitCode: ok ? 0 : 1, stdout: `${JSON.stringify(measurement, null, 2)}\n` };
        }
        return ok
          ? { exitCode: 0, stdout: formatUsage(measurement.usage) }
          : { exitCode: 1, stderr: formatUsage(measurement.usage) };
      }
      if (command === "unregister") {
        try {
          const changed = await unregister();
          return { exitCode: 0, stdout: `${PROFILE.providerId}: ${changed ? "unregistered" : "not configured"}\n` };
        } catch (error) {
          return { exitCode: 1, stderr: `${String(error)}\n` };
        }
      }
      if (command === "status") {
        const root = await dataDir();
        const settingAgents = await readSettingAgents();
        const legacyAgents = readLegacyAgents(root);
        const entry = (settingAgents === null ? undefined : findOwnAgent(settingAgents))
          ?? findOwnAgent(legacyAgents);
        const binary = findBinary(entry);
        let registered = false;
        try {
          registered = (await bb.sdk.providers.list()).some((provider) => provider.id === PROFILE.providerId);
        } catch {}
        const setting = settingAgents?.some(isOwnAgent) ? "present" : "missing";
        const legacy = legacyAgents.some((agent) => isOwnAgent(agent) || isRenamedAgent(agent)) ? "present" : "absent";
        return {
          exitCode: binary && entry && registered ? 0 : 1,
          stdout: [
            `CLI: ${binary ?? "NOT FOUND"}`,
            `ACP customAgents entry: ${setting}`,
            `legacy config.json entry: ${legacy}`,
            `bb provider ${PROFILE.providerId}: ${registered ? "registered" : "NOT registered"}`,
          ].join("\n") + "\n",
        };
      }
      return { exitCode: 2, stderr: `Unknown subcommand "${command}". Use "bb ${PROFILE.id} status".\n` };
    },
  });
}
