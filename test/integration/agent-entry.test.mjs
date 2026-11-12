import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { isDeepStrictEqual } from 'node:util';
import {
  findOwnAgent,
  managedAgent,
  PROFILE,
  parseCustomAgents,
  RENAMED_FROM,
  removeAgent,
  stringifyCustomAgents,
  upsertAgent,
} from '../../src/agent-entry.ts';

const BINARY = '/opt/homebrew/bin/copilot';

function otherAgent(id) {
  return { id, displayName: id, command: id, args: ['--acp'], env: {} };
}

describe('managedAgent', () => {
  it('declares the fields the plugin owns', () => {
    const agent = managedAgent(BINARY);
    assert.partialDeepStrictEqual(agent, {
      id: PROFILE.id,
      displayName: PROFILE.displayName,
      command: BINARY,
      args: ['--acp'],
      env: {},
      nativeSkillRoots: {
        user: ['.copilot/skills', '.agents/skills'],
        project: ['.github/skills', '.agents/skills', '.claude/skills'],
      },
      permissionCli: { full: ['--allow-all'], workspaceWrite: ['--allow-tool=write'] },
    });
  });

  it('keeps keys the user added and env they set, but rewrites the fields it manages', () => {
    const existing = {
      id: PROFILE.id,
      command: 'copilot',
      args: ['--acp', '--banner'],
      env: { COPILOT_ALLOW_ALL: '1' },
      cwd: '/tmp/workspace',
      dialect: 'cursor',
    };
    const agent = managedAgent(BINARY, existing);
    assert.equal(agent.cwd, '/tmp/workspace');
    assert.equal(agent.dialect, 'cursor');
    assert.deepEqual(agent.env, { COPILOT_ALLOW_ALL: '1' });
    assert.deepEqual(agent.args, ['--acp']);
    assert.equal(agent.command, BINARY);
  });

  it('ignores a non-object env rather than passing it through', () => {
    assert.deepEqual(managedAgent(BINARY, { id: PROFILE.id, env: 'nope' }).env, {});
  });

  it('adopts the entry written under the pre-rename id', () => {
    const legacy = {
      id: RENAMED_FROM,
      displayName: PROFILE.displayName,
      command: 'copilot',
      env: { GH_TOKEN: 'x' },
      cwd: '/repo',
    };
    const agent = managedAgent(BINARY, legacy);
    assert.equal(agent.id, PROFILE.id);
    assert.deepEqual(agent.env, { GH_TOKEN: 'x' });
    assert.equal(agent.cwd, '/repo');
  });
});

describe('findOwnAgent', () => {
  it('prefers the current id over the pre-rename one', () => {
    const current = { ...managedAgent(BINARY), cwd: '/current' };
    const stale = { id: RENAMED_FROM, displayName: PROFILE.displayName, cwd: '/stale' };
    assert.equal(findOwnAgent([stale, current])?.cwd, '/current');
  });

  it("does not claim another plugin's copilot entry", () => {
    const theirs = {
      id: RENAMED_FROM,
      displayName: 'Copilot',
      command: 'copilot',
      args: ['--acp', '--stdio'],
    };
    assert.equal(findOwnAgent([theirs]), undefined);
  });
});

describe('upsertAgent', () => {
  it('appends the entry and leaves other agents in place', () => {
    const agents = [otherAgent('auggie'), otherAgent('droid')];
    const result = upsertAgent(agents, managedAgent(BINARY));
    assert.equal(result.changed, true);
    assert.deepEqual(
      result.agents.map((agent) => agent.id),
      ['auggie', 'droid', PROFILE.id]
    );
  });

  it('is idempotent once provisioned', () => {
    const first = upsertAgent([otherAgent('auggie')], managedAgent(BINARY));
    const second = upsertAgent(first.agents, managedAgent(BINARY));
    assert.equal(second.changed, false);
    assert.deepEqual(second.agents, first.agents);
  });

  it('reports a change when the resolved binary moved', () => {
    const provisioned = upsertAgent([], managedAgent('/usr/local/bin/copilot')).agents;
    const result = upsertAgent(provisioned, managedAgent(BINARY));
    assert.equal(result.changed, true);
    assert.equal(result.agents.length, 1);
    assert.equal(result.agents[0]?.command, BINARY);
  });

  it("drops our pre-rename entry without touching the other plugin's", () => {
    const ours = { id: RENAMED_FROM, displayName: PROFILE.displayName, command: 'copilot' };
    const result = upsertAgent([ours, otherAgent('auggie')], managedAgent(BINARY));
    assert.equal(result.changed, true);
    assert.deepEqual(
      result.agents.map((agent) => agent.id),
      ['auggie', PROFILE.id]
    );

    const theirs = { id: RENAMED_FROM, displayName: 'Copilot', command: 'copilot' };
    const kept = upsertAgent([theirs], managedAgent(BINARY));
    assert.ok(kept.agents.some((agent) => isDeepStrictEqual(agent, theirs)));
  });
});

describe('removeAgent', () => {
  it('removes both of our ids and nothing else', () => {
    const theirs = { id: RENAMED_FROM, displayName: 'Copilot' };
    const agents = [
      otherAgent('auggie'),
      managedAgent(BINARY),
      { id: RENAMED_FROM, displayName: PROFILE.displayName },
      theirs,
    ];
    const result = removeAgent(agents);
    assert.equal(result.changed, true);
    assert.deepEqual(result.agents, [otherAgent('auggie'), theirs]);
  });

  it('reports no change when nothing is registered', () => {
    assert.equal(removeAgent([otherAgent('auggie')]).changed, false);
  });
});

describe('parseCustomAgents', () => {
  it('treats an unset or blank setting as no agents', () => {
    assert.deepEqual(parseCustomAgents(undefined), []);
    assert.deepEqual(parseCustomAgents(null), []);
    assert.deepEqual(parseCustomAgents(''), []);
    assert.deepEqual(parseCustomAgents('   \n'), []);
  });

  it('round-trips what stringifyCustomAgents writes', () => {
    const agents = [otherAgent('auggie'), managedAgent(BINARY)];
    assert.deepEqual(parseCustomAgents(stringifyCustomAgents(agents)), agents);
  });

  it('refuses a setting it would otherwise clobber', () => {
    assert.throws(() => parseCustomAgents('{"id":"copilot"}'), /JSON array/);
    assert.throws(() => parseCustomAgents(['already parsed']), /must be a string/);
    assert.throws(() => parseCustomAgents('[not json'));
  });
});
