import { Inject, Injectable, type OnApplicationShutdown, type Provider } from '@nestjs/common';
import { Redis } from 'ioredis';
import { APP_CONFIG, type AppConfig } from '../config/config.js';

/** DI token for the Redis client that holds sessions and login-failure counters. */
export const REDIS_CLIENT = Symbol('REDIS_CLIENT');

export const redisClientProvider: Provider = {
  provide: REDIS_CLIENT,
  inject: [APP_CONFIG],
  // Lazy: the first command connects, so building the app (tests, OpenAPI
  // generation) needs no Redis. Fail requests fast instead of queueing them forever.
  useFactory: (config: AppConfig): Redis =>
    new Redis(config.redisUrl, { lazyConnect: true, maxRetriesPerRequest: 2 }),
};

@Injectable()
export class RedisShutdown implements OnApplicationShutdown {
  constructor(@Inject(REDIS_CLIENT) private readonly redis: Redis) {}

  async onApplicationShutdown(): Promise<void> {
    if (this.redis.status === 'ready') {
      await this.redis.quit();
    } else {
      this.redis.disconnect();
    }
  }
}
