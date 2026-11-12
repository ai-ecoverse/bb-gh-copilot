import assert from 'node:assert/strict';
import { describe, it, mock } from 'node:test';
import {
  createGhTokenReader,
  createSecretReader,
  decodeCredentialBlob,
  readInjectedGithubTokens,
  WINDOWS_CREDENTIAL_SCRIPT,
  windowsCredentialTargets,
} from '../../src/credential-store.ts';

const ACCOUNT = 'https://github.com:octocat';

function calls(fn) {
  return fn.mock.calls.map((call) => call.arguments);
}

describe('decodeCredentialBlob', () => {
  it("decodes keytar's UTF-8 and keyring-rs' UTF-16LE blobs", () => {
    assert.equal(
      decodeCredentialBlob(Buffer.from('gho_abc', 'utf8').toString('base64')),
      'gho_abc'
    );
    assert.equal(
      decodeCredentialBlob(Buffer.from('gho_abcd', 'utf16le').toString('base64')),
      'gho_abcd'
    );
  });

  it('returns null for an empty blob', () => {
    assert.equal(decodeCredentialBlob(''), null);
  });
});

describe('createSecretReader', () => {
  it('reads the macOS keychain', async () => {
    const run = mock.fn(async () => 'gho_stored');
    assert.equal(await createSecretReader(run, 'darwin')('copilot-cli', ACCOUNT), 'gho_stored');
    const [file, args, options] = calls(run).at(-1);
    assert.equal(file, 'security');
    assert.deepEqual(args, ['find-generic-password', '-s', 'copilot-cli', '-a', ACCOUNT, '-w']);
    assert.ok(options);
  });

  it("tries keyring-rs' username attribute, then keytar's account, on Linux", async () => {
    const run = mock.fn(async (_file, args) => (args[3] === 'account' ? 'gho_keytar' : null));
    assert.equal(await createSecretReader(run, 'linux')('copilot-cli', ACCOUNT), 'gho_keytar');
    assert.deepEqual(
      calls(run).map(([file, args]) => [file, ...args]),
      [
        ['secret-tool', 'lookup', 'service', 'copilot-cli', 'username', ACCOUNT],
        ['secret-tool', 'lookup', 'service', 'copilot-cli', 'account', ACCOUNT],
      ]
    );
    run.mock.mockImplementation(async () => 'gho_native');
    run.mock.resetCalls();
    assert.equal(await createSecretReader(run, 'linux')('copilot-cli', ACCOUNT), 'gho_native');
    assert.equal(run.mock.callCount(), 1);
  });

  it('returns null off the supported platforms', async () => {
    const run = mock.fn(async () => 'gho_stored');
    assert.equal(await createSecretReader(run, 'aix')('copilot-cli', ACCOUNT), null);
    assert.equal(run.mock.callCount(), 0);
  });

  it('reads Windows Credential Manager without interpolating the account', async () => {
    const run = mock.fn(async () => Buffer.from('gho_win', 'utf16le').toString('base64'));
    assert.equal(await createSecretReader(run, 'win32')('copilot-cli', ACCOUNT), 'gho_win');
    const [file, args, options] = calls(run)[0];
    assert.equal(file, 'powershell.exe');
    assert.equal(args.at(-1), WINDOWS_CREDENTIAL_SCRIPT);
    assert.ok(!WINDOWS_CREDENTIAL_SCRIPT.includes(ACCOUNT));
    assert.equal(
      options.env?.BB_COPILOT_CREDENTIAL_TARGETS,
      windowsCredentialTargets('copilot-cli', ACCOUNT).join('\n')
    );
    assert.deepEqual(windowsCredentialTargets('copilot-cli', ACCOUNT), [
      `copilot-cli/${ACCOUNT}`,
      `${ACCOUNT}.copilot-cli`,
    ]);
  });

  it('treats a missing Windows credential as no secret', async () => {
    assert.equal(await createSecretReader(async () => null, 'win32')('copilot-cli', ACCOUNT), null);
  });
});

describe('createGhTokenReader', () => {
  it("asks gh for the host's stored token, not an env token it would echo back", async () => {
    const run = mock.fn(async () => 'gho_gh');
    const env = {
      GH_CONFIG_DIR: '/tmp/gh',
      GH_TOKEN: 'ghp_classic',
      GITHUB_TOKEN: 'ghp_classic',
      GH_ENTERPRISE_TOKEN: 'ghp_classic',
      GITHUB_ENTERPRISE_TOKEN: 'ghp_classic',
    };
    assert.equal(await createGhTokenReader(run, env)('acme.ghe.com'), 'gho_gh');
    const [file, args, options] = calls(run)[0];
    assert.equal(file, 'gh');
    assert.deepEqual(args, ['auth', 'token', '--hostname', 'acme.ghe.com']);
    assert.deepEqual(options.env, { GH_CONFIG_DIR: '/tmp/gh' });
  });
});

describe('readInjectedGithubTokens', () => {
  it('reads raw and base64-encoded tokens from the Codespaces env files', () => {
    const files = {
      '/workspaces/.codespaces/shared/.env-secrets': `OTHER=eA==\nGITHUB_TOKEN=${Buffer.from('ghu_injected').toString('base64')}\n`,
      '/workspaces/.codespaces/shared/.env': 'export GITHUB_TOKEN="ghu_plain"\n',
    };
    const tokens = readInjectedGithubTokens((path) => files[path] ?? null);
    assert.ok(tokens.includes('ghu_injected'));
    assert.ok(tokens.includes('ghu_plain'));
    assert.deepEqual(
      readInjectedGithubTokens(() => null),
      []
    );
  });
});
