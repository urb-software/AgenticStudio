import { describe, expect, it } from 'vitest';
import { AgentNotChosenError, AgentProviderMismatchError } from '../../errors/run-errors.js';
import { RunAgentChoice } from '../run-agent-choice.js';

describe('RunAgentChoice', () => {
  it('means the built-in Default agent of the Provider when only a Provider is named', () => {
    expect(RunAgentChoice.of({ provider: 'claude_code' }).name).toBe('default-claude-code');
    expect(RunAgentChoice.of({ provider: 'codex' }).name).toBe('default-codex');
  });

  it('means the named agent, with or without a Provider beside it', () => {
    expect(RunAgentChoice.of({ agent: 'reviewer' }).name).toBe('reviewer');
    expect(RunAgentChoice.of({ agent: 'reviewer', provider: 'codex' }).name).toBe('reviewer');
  });

  it('refuses a request that names neither', () => {
    expect(() => RunAgentChoice.of({})).toThrow(AgentNotChosenError);
  });

  it('accepts the agent Provider when none, or the same one, was named', () => {
    expect(() => RunAgentChoice.of({ agent: 'a' }).assertProvider('codex')).not.toThrow();
    expect(() =>
      RunAgentChoice.of({ agent: 'a', provider: 'codex' }).assertProvider('codex'),
    ).not.toThrow();
    expect(() => RunAgentChoice.of({ provider: 'codex' }).assertProvider('codex')).not.toThrow();
  });

  it('refuses an agent of another Provider than the one named', () => {
    expect(() =>
      RunAgentChoice.of({ agent: 'a', provider: 'codex' }).assertProvider('claude_code'),
    ).toThrow(new AgentProviderMismatchError('claude_code', 'codex'));
  });
});
