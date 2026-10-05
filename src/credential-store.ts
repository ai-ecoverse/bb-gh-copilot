/**
 * Runs a helper binary and resolves its trimmed stdout, or null when it is
 * missing, fails, or times out. Lookups never throw.
 */
export type CommandRunner = (
  file: string,
  args: string[],
  options: { timeoutMs: number; env?: Record<string, string | undefined> },
) => Promise<string | null>;

const SECRET_TIMEOUT_MS = 5_000;
// PowerShell compiles the P/Invoke shim on every call, which can take seconds.
const WINDOWS_SECRET_TIMEOUT_MS = 15_000;
const GH_TIMEOUT_MS = 5_000;
const TARGETS_ENV = "BB_COPILOT_CREDENTIAL_TARGETS";

/**
 * Credential Manager target names Copilot CLI may have used for one login:
 * keytar's `service/account` (the JS CLI, whose macOS entries the native CLI
 * still reads), then keyring-rs' default `account.service`.
 */
export function windowsCredentialTargets(service: string, account: string): string[] {
  return [`${service}/${account}`, `${account}.${service}`];
}

/**
 * Credential Manager blobs are bytes: keytar writes UTF-8, keyring-rs writes
 * UTF-16LE. Tokens are ASCII, so a NUL in every odd byte means UTF-16.
 */
export function decodeCredentialBlob(base64: string): string | null {
  const bytes = Buffer.from(base64.trim(), "base64");
  if (bytes.length === 0) return null;
  const utf16 = bytes.length % 2 === 0 && bytes.every((byte, index) => index % 2 === 0 || byte === 0);
  const text = (utf16 ? bytes.toString("utf16le") : bytes.toString("utf8")).replace(/\0+$/, "").trim();
  return text || null;
}

// Reads the first generic credential found among the targets in
// $env:BB_COPILOT_CREDENTIAL_TARGETS (newline-separated) and prints its blob
// as base64. Targets travel by env var so nothing is interpolated into code.
export const WINDOWS_CREDENTIAL_SCRIPT = `
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
using FILETIME = System.Runtime.InteropServices.ComTypes.FILETIME;
public static class BbCopilotCredential {
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
  private struct CREDENTIAL {
    public int Flags; public int Type; public string TargetName; public string Comment;
    public FILETIME LastWritten; public int CredentialBlobSize; public IntPtr CredentialBlob;
    public int Persist; public int AttributeCount; public IntPtr Attributes;
    public string TargetAlias; public string UserName;
  }
  [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
  private static extern bool CredReadW(string target, int type, int flags, out IntPtr credential);
  [DllImport("advapi32.dll")]
  private static extern void CredFree(IntPtr credential);
  public static string Read(string target) {
    IntPtr pointer;
    if (!CredReadW(target, 1, 0, out pointer)) return null;
    try {
      CREDENTIAL credential = (CREDENTIAL)Marshal.PtrToStructure(pointer, typeof(CREDENTIAL));
      if (credential.CredentialBlobSize <= 0) return null;
      byte[] blob = new byte[credential.CredentialBlobSize];
      Marshal.Copy(credential.CredentialBlob, blob, 0, blob.Length);
      return Convert.ToBase64String(blob);
    } finally {
      CredFree(pointer);
    }
  }
}
'@
foreach ($target in ($env:${TARGETS_ENV} -split "\`n")) {
  if ($target) {
    $blob = [BbCopilotCredential]::Read($target)
    if ($blob) { [Console]::Out.Write($blob); exit 0 }
  }
}
exit 1
`;

/** Reads a generic secret from the OS credential store Copilot CLI uses. */
export function createSecretReader(run: CommandRunner, platform: NodeJS.Platform) {
  return async (service: string, account: string): Promise<string | null> => {
    if (platform === "darwin") {
      return run("security", ["find-generic-password", "-s", service, "-a", account, "-w"], { timeoutMs: SECRET_TIMEOUT_MS });
    }
    if (platform === "linux") {
      // keyring-rs (the native CLI) tags the item `username`; keytar (the JS CLI) used `account`.
      for (const attribute of ["username", "account"]) {
        const secret = await run("secret-tool", ["lookup", "service", service, attribute, account], { timeoutMs: SECRET_TIMEOUT_MS });
        if (secret) return secret;
      }
      return null;
    }
    if (platform === "win32") {
      const blob = await run(
        "powershell.exe",
        ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", WINDOWS_CREDENTIAL_SCRIPT],
        {
          timeoutMs: WINDOWS_SECRET_TIMEOUT_MS,
          env: { ...process.env, [TARGETS_ENV]: windowsCredentialTargets(service, account).join("\n") },
        },
      );
      return blob ? decodeCredentialBlob(blob) : null;
    }
    return null;
  };
}

/** Copilot CLI's last-resort credential: the GitHub CLI's token for the host. */
export function createGhTokenReader(run: CommandRunner, env: Record<string, string | undefined>) {
  return (hostname: string): Promise<string | null> =>
    run("gh", ["auth", "token", "--hostname", hostname], { timeoutMs: GH_TIMEOUT_MS, env });
}
