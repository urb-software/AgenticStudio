/** The agent Providers a Run can use (Issue #96). */
export const PROVIDERS = ['claude_code', 'codex'] as const;
export type Provider = (typeof PROVIDERS)[number];
