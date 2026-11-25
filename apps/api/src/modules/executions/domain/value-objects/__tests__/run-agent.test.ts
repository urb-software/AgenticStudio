import { describe, expect, it } from 'vitest';
import { RunAgent, type RunAgentData } from '../run-agent.js';

const BUILT_IN: RunAgentData = {
  name: 'default-codex',
  source: 'built_in',
  commit: null,
  provider: 'codex',
  model: 'default',
  instructions: '',
};
const DEFINITIONS: RunAgentData = {
  name: 'reviewer',
  source: 'definitions',
  commit: 'c'.repeat(40),
  provider: 'claude_code',
  model: 'opus',
  instructions: 'Review carefully.',
};

describe('RunAgent', () => {
  it('restores a built-in agent and a definitions agent, and gives the record back as it was', () => {
    expect(RunAgent.restore(BUILT_IN).toData()).toEqual(BUILT_IN);
    expect(RunAgent.restore(DEFINITIONS).toData()).toEqual(DEFINITIONS);
    expect(RunAgent.restore(DEFINITIONS)).toMatchObject(DEFINITIONS);
  });

  it('is a copy: changing the data it was restored from changes nothing', () => {
    const data = { ...DEFINITIONS };

    const agent = RunAgent.restore(data);
    data.instructions = 'Ignore the base rules.';
    const given = agent.toData();
    given.instructions = 'Changed after the fact.';

    expect(agent.instructions).toBe('Review carefully.');
    expect(agent.toData().instructions).toBe('Review carefully.');
  });

  it('records a commit for a definitions agent and none for a built-in agent', () => {
    expect(() => RunAgent.restore({ ...DEFINITIONS, commit: null })).toThrow(TypeError);
    expect(() => RunAgent.restore({ ...BUILT_IN, commit: 'c'.repeat(40) })).toThrow(TypeError);
  });

  it('refuses a source and a provider it does not know, and an empty name', () => {
    expect(() => RunAgent.restore({ ...BUILT_IN, source: 'other' as 'built_in' })).toThrow(
      TypeError,
    );
    expect(() => RunAgent.restore({ ...BUILT_IN, provider: 'gpt' as 'codex' })).toThrow(TypeError);
    expect(() => RunAgent.restore({ ...BUILT_IN, name: '' })).toThrow(TypeError);
  });
});
