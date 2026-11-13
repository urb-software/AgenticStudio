export interface AppConfig {
  secretsKey: string;
}

export function loadConfig(env: { STUDIO_SECRETS_KEY: string }): AppConfig {
  const parsed = { secretsKey: env.STUDIO_SECRETS_KEY };
  return { secretsKey: parsed.secretsKey };
}
