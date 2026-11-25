/**
 * The Provider ids and the models an Agent definition may name. This file has no import of
 * its own, so the web app can use it through `@agentic-studio/contracts/providers` without the
 * rest of the contracts (and zod).
 */

/** The agent CLI product that carries out a Run. */
export const PROVIDERS = ['claude_code', 'codex'] as const;
export type Provider = (typeof PROVIDERS)[number];

/** The model value that names "the CLI's own default": no model option is passed. */
export const MODEL_DEFAULT = 'default';

/**
 * The models an Agent definition may name per Provider, the one list for the API, the web app and
 * the agent worker. The values are exactly those approved in the Provider compliance records
 * (docs/engineering/provider-compliance); a change here needs an amendment of the record.
 */
export const PROVIDER_MODELS = {
  claude_code: [MODEL_DEFAULT, 'opus', 'sonnet', 'haiku'],
  codex: [MODEL_DEFAULT, 'gpt-6.2-astra', 'gpt-6.2-sol', 'gpt-6.1-sol', 'gpt-6-luna'],
} as const satisfies Record<Provider, readonly string[]>;
