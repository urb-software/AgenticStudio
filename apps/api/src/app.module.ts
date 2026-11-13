import { type DynamicModule, Module } from '@nestjs/common';
import { ProjectsModule } from './modules/projects/projects.module.js';
import { AuthModule } from './platform/auth/auth.module.js';
import type { AppConfig } from './platform/config/config.js';
import { ConfigModule } from './platform/config/config.module.js';
import { DatabaseModule } from './platform/database/database.module.js';
import { HealthController } from './platform/health/health.controller.js';
import { HttpModule } from './platform/http/http.module.js';
import { SecretsModule } from './platform/secrets/secrets.module.js';

@Module({})
export class AppModule {
  static register(config: AppConfig): DynamicModule {
    return {
      module: AppModule,
      imports: [
        ConfigModule.forRoot(config),
        DatabaseModule,
        HttpModule,
        SecretsModule,
        AuthModule,
        ProjectsModule,
      ],
      controllers: [HealthController],
    };
  }
}
