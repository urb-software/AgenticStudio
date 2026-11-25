import { describe, expect, it } from 'vitest';
import { RunnableAgent } from '../runnable-agent.js';

const USABLE = {
  name: 'reviewer',
  description: 'Reviews',
  provider: 'codex' as const,
  model: 'default',
  source: 'definitions' as const,
  usable: true,
  instructions: 'Review.',
};

describe('RunnableAgent', () => {
  it('is a usable agent with its Provider and model, with its instructions', () => {
    const { usable: _usable, ...shown } = USABLE;
    void _usable;

    expect(RunnableAgent.from(USABLE)).toMatchObject(shown);
  });

  it.each([
    ['is not usable', { usable: false }],
    ['has no Provider', { provider: null }],
    ['has no model', { model: null }],
  ])('is nothing for an agent that %s', (_case, patch) => {
    expect(RunnableAgent.from({ ...USABLE, ...patch })).toBeNull();
  });
});
