import * as contracts from '@agentic-studio/contracts/providers';
import { describe, expect, it } from 'vitest';
import * as definitions from '../index.js';

describe('the Provider constants', () => {
  it('are re-exported, so the web app needs only this package', () => {
    expect(definitions.PROVIDERS).toBe(contracts.PROVIDERS);
    expect(definitions.PROVIDER_MODELS).toBe(contracts.PROVIDER_MODELS);
    expect(definitions.MODEL_DEFAULT).toBe(contracts.MODEL_DEFAULT);
  });

  it('come with the Provider type', () => {
    const provider: definitions.Provider = definitions.PROVIDERS[0];
    expect(definitions.PROVIDER_MODELS[provider]).toContain(definitions.MODEL_DEFAULT);
  });
});

describe('RESERVED_AGENT_NAMES', () => {
  it('names one built-in Default agent per Provider, and the fixed agents route', () => {
    const defaults = definitions.PROVIDERS.map(
      (provider) => `default-${provider.replaceAll('_', '-')}`,
    );
    expect([...definitions.RESERVED_AGENT_NAMES].sort()).toEqual(
      [...defaults, 'definitions-repository'].sort(),
    );
  });
});

describe('the skill API', () => {
  it('exports the validation, the finder and the shell pattern', () => {
    expect(typeof definitions.validateSkillFolder).toBe('function');
    expect(typeof definitions.findSkillFolders).toBe('function');
    expect(definitions.SHELL_LINE).toBeInstanceOf(RegExp);
  });
});

describe('the workflow API', () => {
  it('exports the validation, the finder, the agent check and the limits', () => {
    expect(typeof definitions.validateWorkflowFolder).toBe('function');
    expect(typeof definitions.findWorkflowFolders).toBe('function');
    expect(typeof definitions.checkWorkflowAgents).toBe('function');
    expect(definitions.WORKFLOW_MAX_ITEMS).toBe(12);
    expect(definitions.WORKFLOW_DEFAULT_SEND_BACKS).toBe(2);
    expect(definitions.WORKFLOW_PROBLEM_CODES).toContain('no_phase');
    expect(definitions.PROBLEM_CODES).not.toContain('no_phase');
  });
});
