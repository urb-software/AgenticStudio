import { MAX_FILE_BYTES, WORKFLOW_MAX_ITEMS } from '@agentic-studio/agent-definitions';
import { describe, expect, it } from 'vitest';
import {
  checkpoint,
  COMMIT,
  file,
  listed,
  OK_AGENTS,
  phase,
  scripted,
  workflowText,
} from '../../../__tests__/scripted.js';
import { MAX_READ_BYTES } from '../../../workflows-reader.js';
import { MAX_LISTED_WORKFLOWS, ReadWorkflowsHandler } from '../handler.js';

const handlerOf = (script: Parameters<typeof scripted>[0]) => {
  const fake = scripted({ agents: OK_AGENTS, ...script });
  return { ...fake, handler: new ReadWorkflowsHandler(fake.reader) };
};

const SHIP = [phase('build', 'work', 'builder'), phase('check', 'review', 'reviewer')];

describe('ReadWorkflowsHandler', () => {
  it('answers no Workflow and no commit when no definitions Repository is connected', async () => {
    const { handler, definitions } = handlerOf({ snapshot: null });

    await expect(handler.execute()).resolves.toEqual({
      commit: null,
      repository: null,
      truncated: false,
      workflows: [],
    });
    expect(definitions.listTree).not.toHaveBeenCalled();
  });

  it('says why nothing was read while the Repository has no fetched commit', async () => {
    const { handler, definitions } = handlerOf({ snapshot: { state: 'fetching', commit: null } });

    const result = await handler.execute();

    expect(result.commit).toBeNull();
    expect(result.repository).toEqual({
      state: 'fetching',
      note: expect.stringContaining('A fetch of the Repository is running.') as string,
    });
    expect(definitions.listTree).not.toHaveBeenCalled();
  });

  it('lists a valid Workflow whose agents are valid and whose Providers are available', async () => {
    const { handler, definitions, standings } = handlerOf({
      tree: listed(file('workflows/ship/WORKFLOW.md', 200)),
      files: { 'workflows/ship/WORKFLOW.md': workflowText('ship', SHIP) },
    });

    const result = await handler.execute();

    expect(result.commit).toBe(COMMIT);
    expect(result.repository).toEqual({ state: 'ready', note: null });
    expect(result.truncated).toBe(false);
    expect(result.workflows).toEqual([
      expect.objectContaining({
        name: 'ship',
        description: 'Does ship',
        valid: true,
        usable: true,
        notUsableReason: null,
        problems: [],
        sendBacks: 2,
      }),
    ]);
    expect(definitions.listTree).toHaveBeenCalledWith(COMMIT, { directory: 'workflows' });
    expect(definitions.readFiles).toHaveBeenCalledWith(
      COMMIT,
      ['workflows/ship/WORKFLOW.md'],
      MAX_FILE_BYTES,
    );
    expect(standings.at).toHaveBeenCalledWith(COMMIT, ['builder', 'reviewer']);
  });

  it('lists the Workflows in name order, whatever order Git gave them', async () => {
    const { handler } = handlerOf({
      tree: listed(file('workflows/zeta/WORKFLOW.md'), file('workflows/alpha/WORKFLOW.md')),
      files: {
        'workflows/zeta/WORKFLOW.md': workflowText('zeta'),
        'workflows/alpha/WORKFLOW.md': workflowText('alpha'),
      },
    });

    const { workflows } = await handler.execute();

    expect(workflows.map((workflow) => workflow.name)).toEqual(['alpha', 'zeta']);
  });

  it('lists an invalid Workflow with each reason, and no description or send-back limit', async () => {
    const { handler } = handlerOf({
      tree: listed(file('workflows/broken/WORKFLOW.md'), file('workflows/broken/notes.txt')),
      files: {
        'workflows/broken/WORKFLOW.md': workflowText('broken', [
          checkpoint('ask', 'First'),
          phase('build', 'work', 'builder'),
        ]),
      },
    });

    const { workflows } = await handler.execute();

    expect(workflows[0]).toMatchObject({
      name: 'broken',
      description: null,
      valid: false,
      usable: false,
      notUsableReason: null,
      sendBacks: null,
    });
    expect(
      workflows[0]?.problems.map((problem) => `${problem.code}@${problem.path}`).sort(),
    ).toEqual(['checkpoint_first@WORKFLOW.md', 'workflow_extra_file@notes.txt']);
  });

  it('lists a folder without an entry file as invalid', async () => {
    const { handler } = handlerOf({ tree: listed(file('workflows/empty/readme.txt')) });

    const { workflows } = await handler.execute();

    expect(workflows[0]?.valid).toBe(false);
    expect(workflows[0]?.problems.map((problem) => problem.code)).toContain('entry_missing');
  });

  it('judges a name that needs escaping as invalid and keeps it as text', async () => {
    const odd = '<b>a b';
    const { handler } = handlerOf({
      tree: listed(file(`workflows/${odd}/WORKFLOW.md`)),
      files: { [`workflows/${odd}/WORKFLOW.md`]: workflowText(odd) },
    });

    const { workflows } = await handler.execute();

    expect(workflows[0]).toMatchObject({ name: odd, valid: false });
    expect(workflows[0]?.problems.map((problem) => problem.code)).toContain('name_invalid');
  });

  it('is not valid while a phase names a missing or an invalid agent', async () => {
    const { handler } = handlerOf({
      tree: listed(file('workflows/ship/WORKFLOW.md')),
      files: {
        'workflows/ship/WORKFLOW.md': workflowText('ship', [
          phase('build', 'work', 'gone'),
          phase('check', 'review', 'bad'),
        ]),
      },
      agents: { bad: { valid: false, provider: null } },
    });

    const { workflows } = await handler.execute();

    expect(workflows[0]).toMatchObject({ valid: false, usable: false, description: 'Does ship' });
    expect(workflows[0]?.problems.map((problem) => `${problem.code}:${problem.key}`)).toEqual([
      'phase_agent_missing:gone',
      'phase_agent_invalid:bad',
    ]);
  });

  it('refuses a phase that names a built-in agent, with the reason that says so', async () => {
    const { handler } = handlerOf({
      tree: listed(file('workflows/ship/WORKFLOW.md')),
      files: {
        'workflows/ship/WORKFLOW.md': workflowText('ship', [
          phase('build', 'work', 'default-claude-code'),
        ]),
      },
    });

    const { workflows } = await handler.execute();

    expect(workflows[0]).toMatchObject({ valid: false, usable: false });
    expect(workflows[0]?.problems).toEqual([
      expect.objectContaining({
        code: 'phase_agent_reserved',
        message: expect.stringContaining('reserves') as string,
      }),
    ]);
  });

  it('is valid but not usable, with the Phase and the Provider named, when a Provider is off', async () => {
    const { handler } = handlerOf({
      tree: listed(file('workflows/ship/WORKFLOW.md')),
      files: { 'workflows/ship/WORKFLOW.md': workflowText('ship', SHIP) },
      providers: [
        { id: 'claude_code', name: 'Claude Code', available: true },
        {
          id: 'codex',
          name: 'Codex',
          available: false,
          reason: 'Switched off on the agent worker',
        },
      ],
    });

    const { workflows } = await handler.execute();

    expect(workflows[0]).toMatchObject({
      valid: true,
      usable: false,
      problems: [],
      notUsableReason:
        'The phase "check" uses Codex, which is not available: Switched off on the agent worker.',
    });
  });

  it('applies the send-back limit the Workflow sets', async () => {
    const { handler } = handlerOf({
      tree: listed(file('workflows/ship/WORKFLOW.md')),
      files: { 'workflows/ship/WORKFLOW.md': workflowText('ship', SHIP, 'send-backs: 1\n') },
    });

    const { workflows } = await handler.execute();

    expect(workflows[0]?.sendBacks).toBe(1);
  });

  it('keeps the judged folders per commit and reads Git again for a new commit', async () => {
    const { handler, definitions } = handlerOf({
      tree: listed(file('workflows/ship/WORKFLOW.md')),
      files: { 'workflows/ship/WORKFLOW.md': workflowText('ship', SHIP) },
    });

    await handler.execute();
    await handler.execute();
    expect(definitions.listTree).toHaveBeenCalledTimes(1);

    definitions.snapshot.mockResolvedValue({ state: 'ready', commit: 'b'.repeat(40) });
    await handler.execute();
    expect(definitions.listTree).toHaveBeenCalledTimes(2);
  });

  it('judges the Providers and the agents again on each request', async () => {
    const { handler, providers, standings } = handlerOf({
      tree: listed(file('workflows/ship/WORKFLOW.md')),
      files: { 'workflows/ship/WORKFLOW.md': workflowText('ship', SHIP) },
    });

    await handler.execute();
    await handler.execute();

    expect(providers.list).toHaveBeenCalledTimes(2);
    expect(standings.at).toHaveBeenCalledTimes(2);
  });

  it('lists at most the bound, in name order, and says the list was cut', async () => {
    const entries = [];
    const files: Record<string, string> = {};
    for (let index = 0; index < MAX_LISTED_WORKFLOWS + 3; index += 1) {
      const name = `w${String(index).padStart(3, '0')}`;
      entries.push(file(`workflows/${name}/WORKFLOW.md`));
      files[`workflows/${name}/WORKFLOW.md`] = workflowText(name);
    }
    const { handler } = handlerOf({ tree: listed(...entries), files });

    const result = await handler.execute();

    expect(result.truncated).toBe(true);
    expect(result.workflows).toHaveLength(MAX_LISTED_WORKFLOWS);
    expect(result.workflows[0]?.name).toBe('w000');
  });

  it('stops at the read budget by declared bytes and says the list was cut', async () => {
    const count = MAX_READ_BYTES / MAX_FILE_BYTES + 1;
    const entries = [];
    const files: Record<string, string> = {};
    for (let index = 0; index < count; index += 1) {
      const name = `w${String(index).padStart(2, '0')}`;
      entries.push(file(`workflows/${name}/WORKFLOW.md`, MAX_FILE_BYTES));
      files[`workflows/${name}/WORKFLOW.md`] = workflowText(name);
    }
    const { handler } = handlerOf({ tree: listed(...entries), files });

    const result = await handler.execute();

    expect(result.truncated).toBe(true);
    expect(result.workflows).toHaveLength(count - 1);
  });

  it('does not judge the last folder of a cut listing, which may be partial', async () => {
    const { handler } = handlerOf({
      tree: {
        status: 'listed',
        entries: [file('workflows/one/WORKFLOW.md'), file('workflows/two/WORKFLOW.md')],
        truncated: true,
      },
      files: {
        'workflows/one/WORKFLOW.md': workflowText('one'),
        'workflows/two/WORKFLOW.md': workflowText('two'),
      },
    });

    const result = await handler.execute();

    expect(result.truncated).toBe(true);
    expect(result.workflows.map((workflow) => workflow.name)).toEqual(['one']);
  });

  it('fails closed with a note, and keeps nothing, when the Clone cannot be read', async () => {
    const { handler, definitions } = handlerOf({
      tree: listed(file('workflows/ship/WORKFLOW.md')),
      readFiles: { status: 'failed' },
    });

    const result = await handler.execute();

    expect(result).toMatchObject({
      commit: null,
      workflows: [],
      repository: { state: 'ready', note: 'The Clone of the Repository could not be read.' },
    });
    await handler.execute();
    expect(definitions.listTree).toHaveBeenCalledTimes(2);
  });

  it('explains a Clone that cannot be listed', async () => {
    const { handler } = handlerOf({ tree: { status: 'unsupported_platform' } });

    const result = await handler.execute();

    expect(result.repository?.note).toBe(
      'Studio can read the definitions Repository only on Linux.',
    );
  });

  it('counts every agent as invalid when the agents cannot be judged', async () => {
    const { handler } = handlerOf({
      tree: listed(file('workflows/ship/WORKFLOW.md')),
      files: { 'workflows/ship/WORKFLOW.md': workflowText('ship', SHIP) },
      agents: {},
      settled: false,
    });

    const { workflows } = await handler.execute();

    expect(workflows[0]?.valid).toBe(false);
  });

  it('reads a Workflow of the largest allowed number of items', async () => {
    const items = Array.from({ length: WORKFLOW_MAX_ITEMS }, (_, index) =>
      phase(`p${index}`, 'work', 'builder'),
    );
    const { handler } = handlerOf({
      tree: listed(file('workflows/big/WORKFLOW.md')),
      files: { 'workflows/big/WORKFLOW.md': workflowText('big', items) },
    });

    const { workflows } = await handler.execute();

    expect(workflows[0]).toMatchObject({ valid: true, usable: true });
  });
});
