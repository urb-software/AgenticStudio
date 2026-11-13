import { type DynamicModule, Module } from '@nestjs/common';
import { ProjectsModule } from './modules/projects/projects.module.js';
import { AuthModule } from './platform/auth/auth.module.js';
import type { AppConfig } from './platform/config/config.js';
import { ConfigModule } from './platform/config/config.module.js';
import { DatabaseModule } from './platform/database/database.module.js';
import { HealthModule } from './platform/health/health.module.js';
import { HttpModule } from './platform/http/http.module.js';
import { QueueModule } from './platform/queue/queue.module.js';

@Module({})
export class AppModule {
  static register(config: AppConfig): DynamicModule {
    return {
      module: AppModule,
      imports: [
        ConfigModule.forRoot(config),
        DatabaseModule,
        HttpModule,
        QueueModule.forRoot(),
        HealthModule,
        AuthModule,
        ProjectsModule,
      ],
    };
  }
}
