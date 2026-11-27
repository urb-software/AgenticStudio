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
import { MAX_LISTED_WORKFLOWS } from '../../read-workflows/handler.js';
import { ReadWorkflowHandler } from '../handler.js';

const handlerOf = (script: Parameters<typeof scripted>[0]) => {
  const fake = scripted({ agents: OK_AGENTS, ...script });
  return { ...fake, handler: new ReadWorkflowHandler(fake.reader) };
};

const SEQUENCE = [
  phase('build', 'work', 'builder'),
  checkpoint('ask', 'Look before going on'),
  phase('check', 'review', 'reviewer'),
];

const TREE = listed(
  file('workflows/ship/WORKFLOW.md'),
  file('workflows/other/WORKFLOW.md'),
  file('workflows/other/extra.txt'),
);

describe('ReadWorkflowHandler', () => {
  it('answers the Workflow with its items in order, each phase with its agent and state', async () => {
    const { handler } = handlerOf({
      tree: TREE,
      files: { 'workflows/ship/WORKFLOW.md': workflowText('ship', SEQUENCE, 'send-backs: 1\n') },
    });

    const result = await handler.execute({ name: 'ship' });

    expect(result.commit).toBe(COMMIT);
    expect(result.workflow).toMatchObject({
      name: 'ship',
      valid: true,
      usable: true,
      sendBacks: 1,
      items: [
        {
          id: 'build',
          kind: 'work',
          agent: 'builder',
          agentState: 'valid',
          provider: 'claude_code',
          usable: true,
        },
        { id: 'ask', kind: 'checkpoint', text: 'Look before going on' },
        {
          id: 'check',
          kind: 'review',
          agent: 'reviewer',
          agentState: 'valid',
          provider: 'codex',
          usable: true,
        },
      ],
    });
  });

  it('reads only its own folder and judges only the agents it names', async () => {
    const { handler, definitions, standings } = handlerOf({
      tree: TREE,
      files: { 'workflows/ship/WORKFLOW.md': workflowText('ship', SEQUENCE) },
    });

    await handler.execute({ name: 'ship' });

    expect(definitions.readFiles).toHaveBeenCalledTimes(1);
    expect(definitions.readFiles.mock.calls[0]?.[1]).toEqual(['workflows/ship/WORKFLOW.md']);
    expect(standings.at).toHaveBeenCalledWith(COMMIT, ['builder', 'reviewer']);
  });

  it('marks the phase whose agent is missing or invalid, and the one whose Provider is off', async () => {
    const { handler } = handlerOf({
      tree: TREE,
      files: {
        'workflows/ship/WORKFLOW.md': workflowText('ship', [
          phase('a', 'work', 'gone'),
          phase('b', 'work', 'bad'),
          phase('c', 'review', 'reviewer'),
        ]),
      },
      agents: { bad: { valid: false, provider: null }, reviewer: OK_AGENTS['reviewer']! },
      providers: [
        { id: 'claude_code', name: 'Claude Code', available: true },
        { id: 'codex', name: 'Codex', available: false, reason: 'No agent worker is connected' },
      ],
    });

    const { workflow } = await handler.execute({ name: 'ship' });

    expect(workflow?.items.map((item) => item.kind !== 'checkpoint' && item.agentState)).toEqual([
      'missing',
      'invalid',
      'valid',
    ]);
    expect(workflow?.items.map((item) => item.kind !== 'checkpoint' && item.usable)).toEqual([
      false,
      false,
      false,
    ]);
  });

  it('answers an invalid Workflow with its reasons and no items', async () => {
    const { handler } = handlerOf({
      tree: TREE,
      files: { 'workflows/other/WORKFLOW.md': 'no front matter' },
    });

    const { workflow } = await handler.execute({ name: 'other' });

    expect(workflow).toMatchObject({ valid: false, usable: false, sendBacks: null, items: [] });
    expect(workflow?.problems.map((problem) => problem.code)).toEqual(
      expect.arrayContaining(['front_matter_missing', 'workflow_extra_file']),
    );
  });

  it('answers no Workflow for a name no folder has', async () => {
    const { handler } = handlerOf({ tree: TREE });

    const result = await handler.execute({ name: 'gone' });

    expect(result.workflow).toBeNull();
    expect(result.commit).toBe(COMMIT);
  });

  it('answers no commit and no Workflow when no definitions Repository is connected', async () => {
    const { handler, definitions } = handlerOf({ snapshot: null });

    await expect(handler.execute({ name: 'ship' })).resolves.toEqual({
      commit: null,
      repository: null,
      workflow: null,
    });
    expect(definitions.listTree).not.toHaveBeenCalled();
  });

  it('reads a Workflow beyond the cut list by itself', async () => {
    const entries = [];
    const files: Record<string, string> = {};
    for (let index = 0; index < MAX_LISTED_WORKFLOWS + 3; index += 1) {
      const name = `w${String(index).padStart(3, '0')}`;
      entries.push(file(`workflows/${name}/WORKFLOW.md`));
      files[`workflows/${name}/WORKFLOW.md`] = workflowText(name);
    }
    const last = `w${String(MAX_LISTED_WORKFLOWS + 2).padStart(3, '0')}`;
    const { handler, definitions } = handlerOf({ tree: listed(...entries), files });

    const result = await handler.execute({ name: last });

    expect(result.workflow?.name).toBe(last);
    expect(definitions.readFiles.mock.calls.at(-1)?.[1]).toEqual([`workflows/${last}/WORKFLOW.md`]);
  });

  it('serves a Workflow from the judged folders of the commit once the list was read', async () => {
    const { handler, definitions, reader } = handlerOf({
      tree: TREE,
      files: { 'workflows/ship/WORKFLOW.md': workflowText('ship', SEQUENCE) },
    });

    await reader.read();
    await handler.execute({ name: 'ship' });
    await handler.execute({ name: 'ship' });

    expect(definitions.listTree).toHaveBeenCalledTimes(1);
  });

  it('fails closed, answering no Workflow, when the Clone cannot be read', async () => {
    const { handler } = handlerOf({ tree: TREE, readFiles: { status: 'failed' } });

    const result = await handler.execute({ name: 'ship' });

    expect(result.workflow).toBeNull();
    expect(result.repository?.note).toBe('The Clone of the Repository could not be read.');
  });
});
