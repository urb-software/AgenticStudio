import { type DynamicModule, Module } from '@nestjs/common';
import { APP_CONFIG, type AppConfig } from '../../platform/config/config.js';
import { DatabaseModule } from '../../platform/database/database.module.js';
import { GetPreviewHandler } from './application/features/get-preview/handler.js';
import { RemovePreviewSettingsHandler } from './application/features/remove-preview-settings/handler.js';
import { SavePreviewSettingsHandler } from './application/features/save-preview-settings/handler.js';
import {
  PREVIEW_DOMAIN_SETTINGS,
  type PreviewDomainSettings,
} from './application/ports/preview-domain.js';
import { PREVIEW_SETTINGS_REPOSITORY } from './domain/repositories/preview-settings-repository.js';
import { GetPreviewEndpoint } from './entry-points/http/operator/get-preview/endpoint.js';
import { RemovePreviewSettingsEndpoint } from './entry-points/http/operator/remove-preview-settings/endpoint.js';
import { SavePreviewSettingsEndpoint } from './entry-points/http/operator/save-preview-settings/endpoint.js';
import { PrismaPreviewSettingsRepository } from './infrastructure/repositories/prisma-preview-settings-repository.js';

/**
 * `environments` business module: a Project's Preview settings. It reaches the Repository only
 * through the `projects` module's public contract, which the composition root passes in.
 */
@Module({})
export class EnvironmentsModule {
  static register(projects: DynamicModule): DynamicModule {
    return {
      module: EnvironmentsModule,
      imports: [DatabaseModule, projects],
      controllers: [GetPreviewEndpoint, SavePreviewSettingsEndpoint, RemovePreviewSettingsEndpoint],
      providers: [
        { provide: PREVIEW_SETTINGS_REPOSITORY, useClass: PrismaPreviewSettingsRepository },
        {
          provide: PREVIEW_DOMAIN_SETTINGS,
          useFactory: (config: AppConfig): PreviewDomainSettings => ({
            domain: config.previewDomain,
          }),
          inject: [APP_CONFIG],
        },
        GetPreviewHandler,
        SavePreviewSettingsHandler,
        RemovePreviewSettingsHandler,
      ],
    };
  }
}
