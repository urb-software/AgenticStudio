import { type DynamicModule, Module } from '@nestjs/common';
import { EnvironmentsModule } from './modules/environments/environments.module.js';
import {
  ExecutionsModule,
  type ExecutionsModuleOptions,
} from './modules/executions/executions.module.js';
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
  /** Test seams; production passes none. `{ startWorkers: false }` builds without Redis. */
  static register(
    config: AppConfig,
    options: {
      queue?: QueueWorkerTuning;
      projects?: ProjectsModuleOptions;
      executions?: ExecutionsModuleOptions;
    } = {},
  ): DynamicModule {
    // One instance: `executions` and `environments` import this same module to reach its public contract.
    const projects = ProjectsModule.register(options.projects);
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
        projects,
        ExecutionsModule.register(projects, options.executions),
        EnvironmentsModule.register(projects),
      ],
    };
  }
}
