import { describe, expect, it } from 'vitest';
import { WorkflowUsability } from '../workflow-usability.js';

const PROVIDERS = [
  { id: 'claude_code', name: 'Claude Code', available: true },
  { id: 'codex', name: 'Codex', available: false, reason: 'Switched off on the agent worker' },
] as const;

const phase = (id: string, state: 'valid' | 'invalid' | 'missing', provider: string | null) => ({
  id,
  agentState: state,
  provider: provider as 'claude_code' | 'codex' | null,
});

describe('WorkflowUsability', () => {
  it('is usable when the workflow is valid and every Provider of its phases is available', () => {
    const usability = WorkflowUsability.of(
      true,
      [phase('build', 'valid', 'claude_code')],
      PROVIDERS,
    );

    expect(usability.usable).toBe(true);
    expect(usability.reason).toBeNull();
    expect(usability.isPhaseUsable('build')).toBe(true);
  });

  it('is not usable, with a reason naming the phase and the Provider, when a Provider is off', () => {
    const usability = WorkflowUsability.of(
      true,
      [phase('build', 'valid', 'claude_code'), phase('check', 'valid', 'codex')],
      PROVIDERS,
    );

    expect(usability.usable).toBe(false);
    expect(usability.reason).toBe(
      'The phase "check" uses Codex, which is not available: Switched off on the agent worker.',
    );
    expect(usability.isPhaseUsable('build')).toBe(true);
    expect(usability.isPhaseUsable('check')).toBe(false);
  });

  it('names every phase whose Provider is not available', () => {
    const usability = WorkflowUsability.of(
      true,
      [phase('a', 'valid', 'codex'), phase('b', 'valid', 'codex')],
      PROVIDERS,
    );

    expect(usability.reason).toContain('"a"');
    expect(usability.reason).toContain('"b"');
  });

  it('is not usable and has no Provider reason when the workflow is not valid', () => {
    const usability = WorkflowUsability.of(false, [phase('build', 'valid', 'codex')], PROVIDERS);

    expect(usability.usable).toBe(false);
    expect(usability.reason).toBeNull();
  });

  it.each(['invalid', 'missing'] as const)('does not use a phase whose agent is %s', (state) => {
    const usability = WorkflowUsability.of(false, [phase('build', state, null)], PROVIDERS);

    expect(usability.isPhaseUsable('build')).toBe(false);
  });

  it('treats a Provider the list does not know as not available', () => {
    const usability = WorkflowUsability.of(true, [phase('build', 'valid', 'codex')], []);

    expect(usability.usable).toBe(false);
    expect(usability.reason).toBe('The phase "build" uses Codex, which is not available.');
  });
});
