import { PostgreSqlContainer } from '@testcontainers/postgresql';
import { RedisContainer } from '@testcontainers/redis';

// Keep in sync with compose.yaml so tests run against the same server versions.
export const POSTGRES_IMAGE = 'postgres:18.6-alpine';
export const REDIS_IMAGE = 'redis:8.10.3-alpine';

/** A throwaway service container. `url` is a connection string for clients. */
export interface TestService {
  url: string;
  stop(): Promise<void>;
}

/** Starts an empty, throwaway PostgreSQL database. Credentials are test-only. */
export async function startPostgres(): Promise<TestService> {
  const container = await new PostgreSqlContainer(POSTGRES_IMAGE).start();
  return {
    url: container.getConnectionUri(),
    stop: async () => {
      await container.stop();
    },
  };
}

/** Starts an empty, throwaway Redis server. */
export async function startRedis(): Promise<TestService> {
  const container = await new RedisContainer(REDIS_IMAGE).start();
  return {
    url: container.getConnectionUrl(),
    stop: async () => {
      await container.stop();
    },
  };
}
