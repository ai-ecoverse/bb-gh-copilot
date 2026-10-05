import { describe, expect, it, vi } from "vitest";
import {
  createGhTokenReader,
  createSecretReader,
  decodeCredentialBlob,
  windowsCredentialTargets,
  WINDOWS_CREDENTIAL_SCRIPT,
  type CommandRunner,
} from "./credential-store.js";

const ACCOUNT = "https://github.com:octocat";

describe("decodeCredentialBlob", () => {
  it("decodes keytar's UTF-8 and keyring-rs' UTF-16LE blobs", () => {
    expect(decodeCredentialBlob(Buffer.from("gho_abc", "utf8").toString("base64"))).toBe("gho_abc");
    expect(decodeCredentialBlob(Buffer.from("gho_abcd", "utf16le").toString("base64"))).toBe("gho_abcd");
  });

  it("returns null for an empty blob", () => {
    expect(decodeCredentialBlob("")).toBeNull();
  });
});

describe("createSecretReader", () => {
  it("uses the platform's credential store", async () => {
    const run = vi.fn<CommandRunner>(async () => "gho_stored");
    expect(await createSecretReader(run, "darwin")("copilot-cli", ACCOUNT)).toBe("gho_stored");
    expect(run).toHaveBeenLastCalledWith(
      "security", ["find-generic-password", "-s", "copilot-cli", "-a", ACCOUNT, "-w"], expect.anything(),
    );
    await createSecretReader(run, "linux")("copilot-cli", ACCOUNT);
    expect(run).toHaveBeenLastCalledWith(
      "secret-tool", ["lookup", "service", "copilot-cli", "account", ACCOUNT], expect.anything(),
    );
    run.mockClear();
    expect(await createSecretReader(run, "aix")("copilot-cli", ACCOUNT)).toBeNull();
    expect(run).not.toHaveBeenCalled();
  });

  it("reads Windows Credential Manager without interpolating the account", async () => {
    const run = vi.fn<CommandRunner>(async () => Buffer.from("gho_win", "utf16le").toString("base64"));
    expect(await createSecretReader(run, "win32")("copilot-cli", ACCOUNT)).toBe("gho_win");
    const [file, args, options] = run.mock.calls[0]!;
    expect(file).toBe("powershell.exe");
    expect(args.at(-1)).toBe(WINDOWS_CREDENTIAL_SCRIPT);
    expect(WINDOWS_CREDENTIAL_SCRIPT).not.toContain(ACCOUNT);
    expect(options.env?.BB_COPILOT_CREDENTIAL_TARGETS).toBe(windowsCredentialTargets("copilot-cli", ACCOUNT).join("\n"));
    expect(windowsCredentialTargets("copilot-cli", ACCOUNT))
      .toEqual([`copilot-cli/${ACCOUNT}`, `${ACCOUNT}.copilot-cli`]);
  });

  it("treats a missing Windows credential as no secret", async () => {
    expect(await createSecretReader(async () => null, "win32")("copilot-cli", ACCOUNT)).toBeNull();
  });
});

describe("createGhTokenReader", () => {
  it("asks gh for the host's token with Copilot's environment", async () => {
    const run = vi.fn<CommandRunner>(async () => "gho_gh");
    const env = { GH_CONFIG_DIR: "/tmp/gh" };
    expect(await createGhTokenReader(run, env)("acme.ghe.com")).toBe("gho_gh");
    expect(run).toHaveBeenCalledWith("gh", ["auth", "token", "--hostname", "acme.ghe.com"], expect.objectContaining({ env }));
  });
});
