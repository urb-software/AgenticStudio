import { createDatabaseClient, type DatabaseClient } from '@agentic-studio/database';
import { Inject, Injectable, Module, type OnApplicationShutdown } from '@nestjs/common';
import { APP_CONFIG, type AppConfig } from '../config/config.js';

export type { DatabaseClient };

/**
 * DI token for the Prisma client. Only infrastructure adapters (e.g. a module's
 * `infrastructure/repositories/`) inject it; `domain/` and handlers never do.
 */
export const DATABASE_CLIENT = Symbol('DATABASE_CLIENT');

@Injectable()
class DatabaseShutdown implements OnApplicationShutdown {
  constructor(@Inject(DATABASE_CLIENT) private readonly client: DatabaseClient) {}

  async onApplicationShutdown(): Promise<void> {
    await this.client.$disconnect();
  }
}

@Module({
  providers: [
    {
      provide: DATABASE_CLIENT,
      inject: [APP_CONFIG],
      useFactory: (config: AppConfig): DatabaseClient => createDatabaseClient(config.databaseUrl),
    },
    DatabaseShutdown,
  ],
  exports: [DATABASE_CLIENT],
})
export class DatabaseModule {}
