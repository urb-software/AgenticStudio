import { z } from 'zod';

const DEFAULT_API_PORT = 3001;

const environmentSchema = z.object({
  // API_PORT, not PORT: `next dev` also reads PORT, so a shell-wide PORT would put
  // both apps on the same port.
  API_PORT: z.coerce.number().int().min(1).max(65535).default(DEFAULT_API_PORT),
  // Where the web app's `next dev` /api rewrite reaches this API.
  API_ORIGIN: z.url({ protocol: /^https?$/ }).default(`http://localhost:${DEFAULT_API_PORT}`),
  DATABASE_URL: z.url({ protocol: /^postgres(ql)?$/ }),
});

export interface AppConfig {
  apiPort: number;
  apiOrigin: string;
  databaseUrl: string;
}

/** DI token for the validated {@link AppConfig}. */
export const APP_CONFIG = Symbol('APP_CONFIG');

/** Thrown when the environment is invalid. Names variables, never their values. */
export class ConfigValidationError extends Error {
  constructor(problems: string[]) {
    super(`Invalid environment configuration:\n${problems.map((p) => `  - ${p}`).join('\n')}`);
    this.name = 'ConfigValidationError';
  }
}

/** Validates the environment once at start-up; throws instead of running half-configured. */
export function loadConfig(env: Record<string, string | undefined>): AppConfig {
  const result = environmentSchema.safeParse(env);
  if (!result.success) {
    throw new ConfigValidationError(
      result.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`),
    );
  }
  return {
    apiPort: result.data.API_PORT,
    apiOrigin: result.data.API_ORIGIN,
    databaseUrl: result.data.DATABASE_URL,
  };
}
