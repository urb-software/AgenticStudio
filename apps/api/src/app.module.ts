import { type DynamicModule, Module } from '@nestjs/common';
import { ProjectsModule, type ProjectsModuleOptions } from './modules/projects/projects.module.js';
import { AuthModule } from './platform/auth/auth.module.js';
import type { AppConfig } from './platform/config/config.js';
import { ConfigModule } from './platform/config/config.module.js';
import { DatabaseModule } from './platform/database/database.module.js';
import { HealthModule } from './platform/health/health.module.js';
import { HttpModule } from './platform/http/http.module.js';
import { QueueModule, type QueueWorkerTuning } from './platform/queue/queue.module.js';
import { SecretsModule } from './platform/secrets/secrets.module.js';

@Module({})
export class AppModule {
  /**
   * Test seams; production passes no options. `queue` tunes the job-queue workers (e.g.
   * `{ startWorkers: false }` builds the app without Redis, as OpenAPI generation does);
   * `projects` shortens the Git limits or changes the platform for tests.
   */
  static register(
    config: AppConfig,
    options: { queue?: QueueWorkerTuning; projects?: ProjectsModuleOptions } = {},
  ): DynamicModule {
    return {
      module: AppModule,
      imports: [
        ConfigModule.forRoot(config),
        DatabaseModule,
        HttpModule,
        QueueModule.forRoot(options.queue),
        HealthModule,
        SecretsModule,
        AuthModule,
        ProjectsModule.register(options.projects),
      ],
    };
  }
}
