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
} from '../../../application/__tests__/scripted.js';

const ENTRY = 'workflows/ship/WORKFLOW.md';

const shipping = (text: string, agents = OK_AGENTS) =>
  scripted({
    agents,
    tree: listed(file(ENTRY)),
    files: { [ENTRY]: text },
  }).plans;

describe('the Workflow plans', () => {
  it('resolves a Workflow to the plan a Run records: name, commit and items in order', async () => {
    const plans = shipping(
      workflowText('ship', [
        phase('build', 'work', 'builder'),
        checkpoint('look', 'Look at it.'),
        phase('check', 'review', 'reviewer'),
      ]),
    );

    expect(await plans.resolve('p', 'ship')).toEqual({
      status: 'resolved',
      plan: {
        name: 'ship',
        commit: COMMIT,
        items: [
          { id: 'build', kind: 'work', agent: 'builder' },
          { id: 'look', kind: 'checkpoint', text: 'Look at it.' },
          { id: 'check', kind: 'review', agent: 'reviewer' },
        ],
      },
    });
  });

  it('keeps the instructions of a Phase in the plan', async () => {
    const plans = shipping(
      workflowText('ship', [`${phase('build', 'work', 'builder')}\n    instructions: Be brief.`]),
    );

    expect(await plans.resolve('p', 'ship')).toMatchObject({
      plan: { items: [{ id: 'build', instructions: 'Be brief.' }] },
    });
  });

  it('says a Workflow no folder has is unknown', async () => {
    expect(await shipping(workflowText('ship')).resolve('p', 'nope')).toEqual({
      status: 'unknown',
    });
  });

  it('says it is unknown when no definitions Repository is connected', async () => {
    const plans = scripted({ snapshot: null }).plans;

    expect(await plans.resolve('p', 'ship')).toEqual({ status: 'unknown' });
  });

  it('refuses a Workflow whose entry file has problems, naming them', async () => {
    const result = await shipping('no front matter').resolve('p', 'ship');

    expect(result).toMatchObject({ status: 'not_usable' });
    expect((result as { reason: string }).reason).toContain('The Workflow has problems');
  });

  it('refuses a Workflow whose Phase names an agent that is missing or invalid', async () => {
    const missing = await shipping(workflowText('ship'), {}).resolve('p', 'ship');
    const invalid = await shipping(workflowText('ship'), {
      builder: { valid: false, provider: null },
    }).resolve('p', 'ship');

    expect(missing).toMatchObject({ status: 'not_usable' });
    expect(invalid).toMatchObject({ status: 'not_usable' });
  });

  it('does not judge Provider availability: the Run start does', async () => {
    const fake = scripted({
      agents: OK_AGENTS,
      tree: listed(file(ENTRY)),
      files: { [ENTRY]: workflowText('ship') },
      providers: [{ id: 'claude_code', name: 'Claude Code', available: false }],
    });

    expect(await fake.plans.resolve('p', 'ship')).toMatchObject({ status: 'resolved' });
    expect(fake.providers.list).not.toHaveBeenCalled();
  });

  it('puts the Phases one after the other, over the recorded plan alone', () => {
    const { plans } = scripted({});
    const plan = {
      name: 'ship',
      commit: COMMIT,
      items: [
        { id: 'a', kind: 'work' as const, agent: 'x' },
        { id: 'b', kind: 'work' as const, agent: 'y' },
      ],
    };

    expect(plans.next(plan, 0, 'done')).toEqual({ kind: 'phase', position: 1 });
    expect(plans.next(plan, 1, 'done')).toEqual({ kind: 'end' });
  });

  it('goes on after an approval and ends the Workflow when changes are requested', () => {
    const { plans } = scripted({});
    const plan = {
      name: 'ship',
      commit: COMMIT,
      items: [
        { id: 'a', kind: 'work' as const, agent: 'x' },
        { id: 'b', kind: 'review' as const, agent: 'y' },
        { id: 'c', kind: 'work' as const, agent: 'x' },
      ],
    };

    expect(plans.next(plan, 1, 'approved')).toEqual({ kind: 'phase', position: 2 });
    expect(plans.next(plan, 1, 'changes_requested')).toEqual({ kind: 'end' });
  });

  it('reads Workflows only at the published commit, so one that exists only in a Draft is unknown', async () => {
    const fake = scripted({
      agents: OK_AGENTS,
      tree: listed(file(ENTRY)),
      files: { [ENTRY]: workflowText('ship') },
    });

    expect(await fake.plans.resolve('p', 'draft-only')).toEqual({ status: 'unknown' });
    expect(await fake.plans.resolve('p', 'ship')).toMatchObject({
      status: 'resolved',
      plan: { commit: COMMIT },
    });
    // Every read names the published commit; the plans have no way to ask for a Draft.
    for (const [commit] of fake.definitions.listTree.mock.calls as unknown as [string][]) {
      expect(commit).toBe(COMMIT);
    }
    for (const [commit] of fake.definitions.readFiles.mock.calls) expect(commit).toBe(COMMIT);
  });
});
