import { describe, expect, it } from 'vitest';
import { RunAgentPreselection } from '../run-agent-preselection.js';

const AGENTS = [
  { name: 'default-claude-code', usable: true },
  { name: 'default-codex', usable: true },
  { name: 'reviewer', usable: true },
  { name: 'broken', usable: false },
];

describe('RunAgentPreselection', () => {
  it('preselects the Default agent of Claude Code when the Project names none', () => {
    const chosen = RunAgentPreselection.of(AGENTS, null);

    expect(chosen.agent).toBe('default-claude-code');
    expect(chosen.reason).toBeNull();
  });

  it('preselects the default of the Project when it is usable, a built-in one too', () => {
    expect(RunAgentPreselection.of(AGENTS, 'reviewer')).toMatchObject({
      agent: 'reviewer',
      reason: null,
    });
    expect(RunAgentPreselection.of(AGENTS, 'default-codex')).toMatchObject({
      agent: 'default-codex',
      reason: null,
    });
  });

  it('falls back with the reason when the default has problems', () => {
    const chosen = RunAgentPreselection.of(AGENTS, 'broken');

    expect(chosen.agent).toBe('default-claude-code');
    expect(chosen.reason).toContain('broken');
    expect(chosen.reason).toContain('its definition has problems');
  });

  it('falls back with the reason when no agent has the default name any more', () => {
    const chosen = RunAgentPreselection.of(AGENTS, 'removed');

    expect(chosen.agent).toBe('default-claude-code');
    expect(chosen.reason).toContain('no agent has this name');
  });

  it('takes a usable agent over a refused folder of the same name', () => {
    const chosen = RunAgentPreselection.of(
      [
        { name: 'default-codex', usable: true },
        { name: 'default-codex', usable: false },
      ],
      'default-codex',
    );

    expect(chosen).toMatchObject({ agent: 'default-codex', reason: null });
  });
});
