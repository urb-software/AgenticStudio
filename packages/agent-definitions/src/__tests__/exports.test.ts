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
  it('names one built-in Default agent per Provider, and the fixed agents routes', () => {
    const defaults = definitions.PROVIDERS.map(
      (provider) => `default-${provider.replaceAll('_', '-')}`,
    );
    expect([...definitions.RESERVED_AGENT_NAMES].sort()).toEqual(
      [...defaults, 'definitions-repository', 'files'].sort(),
    );
  });
});
