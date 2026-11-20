interface Config {
  secretsKey: string;
}

// Forbidden: only platform/config and platform/secrets read the master key.
export function masterKeyOf(config: Config): string {
  return config.secretsKey;
}
