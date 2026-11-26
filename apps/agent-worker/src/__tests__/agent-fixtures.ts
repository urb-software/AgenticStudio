import { BASE_RULES, type Provider, type RunPayload } from '@agentic-studio/contracts';

/** What every claim of a Run with the built-in Default agent carries besides the Run itself. */
export function agentFields(
  provider: Provider = 'claude_code',
): Pick<RunPayload, 'baseRules' | 'agent' | 'skills'> {
  return {
    baseRules: { version: BASE_RULES.version, text: BASE_RULES.text },
    skills: [],
    agent: {
      name: `default-${provider.replaceAll('_', '-')}`,
      source: 'built_in',
      commit: null,
      provider,
      model: 'default',
      instructions: '',
    },
  };
}
