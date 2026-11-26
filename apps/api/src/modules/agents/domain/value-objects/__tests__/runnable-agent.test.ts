import { describe, expect, it } from 'vitest';
import { isRunnable, RunnableAgent } from '../runnable-agent.js';

const USABLE = {
  name: 'reviewer',
  description: 'Reviews',
  provider: 'codex' as const,
  model: 'default',
  source: 'definitions' as const,
  usable: true,
  instructions: 'Review.',
  skills: [] as string[],
};

describe('RunnableAgent', () => {
  it('is a usable agent with its Provider and model, with its instructions', () => {
    const { usable: _usable, ...shown } = USABLE;
    void _usable;

    expect(isRunnable(USABLE)).toBe(true);
    expect(isRunnable(USABLE) && RunnableAgent.of(USABLE)).toMatchObject(shown);
  });

  it.each([
    ['is not usable', { usable: false }],
    ['has no Provider', { provider: null }],
    ['has no model', { model: null }],
  ])('is not runnable when the agent %s', (_case, patch) => {
    expect(isRunnable({ ...USABLE, ...patch })).toBe(false);
  });
});
