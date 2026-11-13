interface Config {
  secretsKey: string;
}

// Forbidden: only platform/config and platform/secrets read the master key.
export function masterKeyOf(config: Config): string[] {
  const { secretsKey } = config;
  return [secretsKey, config.secretsKey, config['secretsKey']];
}
