import { PROVIDER_MODELS } from '@agentic-studio/agent-definitions';
import { describe, expect, it } from 'vitest';
import { ListProvidersHandler } from '../handler.js';

// The Providers answer lists the models of each Provider besides its availability.

const handler = () =>
  new ListProvidersHandler(
    { latest: () => undefined, record: () => undefined } as never,
    { now: () => new Date('2026-11-25T10:00:00Z') },
    { seconds: 60 },
  );

describe('ListProvidersHandler', () => {
  it('lists the allowed models of each Provider, from the one list the worker checks', async () => {
    const providers = await handler().execute();

    expect(providers.map((provider) => [provider.id, provider.models])).toEqual([
      ['claude_code', [...PROVIDER_MODELS.claude_code]],
      ['codex', [...PROVIDER_MODELS.codex]],
    ]);
    expect(providers[0]?.models).toEqual(['default', 'opus', 'sonnet', 'haiku']);
  });

  it('lists the models of a Provider that is unavailable too', async () => {
    const providers = await handler().execute();

    expect(providers.every((provider) => !provider.available)).toBe(true);
    expect(providers.every((provider) => provider.models.length > 1)).toBe(true);
  });
});
