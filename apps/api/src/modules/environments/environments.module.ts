import { type DynamicModule, Module } from '@nestjs/common';
import { APP_CONFIG, type AppConfig } from '../../platform/config/config.js';
import { DatabaseModule } from '../../platform/database/database.module.js';
import { SecretsModule } from '../../platform/secrets/secrets.module.js';
import { AppendPreviewOperationLogHandler } from './application/features/append-preview-operation-log/handler.js';
import { ClaimPreviewOperationHandler } from './application/features/claim-preview-operation/handler.js';
import { GetPreviewOperationSourceHandler } from './application/features/get-preview-operation-source/handler.js';
import { ReportPreviewOperationStateHandler } from './application/features/report-preview-operation-state/handler.js';
import { RequestPreviewOperationHandler } from './application/features/request-preview-operation/handler.js';
import { SweepPreviewEnvironmentFilesHandler } from './application/features/sweep-preview-environment-files/handler.js';
import { CLOCK, type Clock } from './application/ports/clock.js';
import {
  PREVIEW_LIMITS,
  type PreviewLimitsSettings,
} from './application/ports/preview-limits-settings.js';
import { PREVIEW_SNAPSHOT_GRACE_MS } from './application/ports/preview-environment-file-snapshots.js';
import { PREVIEW_OPERATION_LOG } from './application/ports/preview-operation-log.js';
import {
  PREVIEW_OPERATION_SETTINGS,
  type PreviewOperationSettings,
} from './application/ports/preview-operation-settings.js';
import { PREVIEW_SECRET_VALUES } from './application/ports/preview-secret-values.js';
import { PREVIEW_OPERATION_REPOSITORY } from './domain/repositories/preview-operation-repository.js';
import { AppendOperationLogEndpoint } from './entry-points/http/environment-controller/append-operation-log/endpoint.js';
import { ClaimOperationEndpoint } from './entry-points/http/environment-controller/claim-operation/endpoint.js';
import { GetOperationSourceEndpoint } from './entry-points/http/environment-controller/get-operation-source/endpoint.js';
import { ReportOperationStateEndpoint } from './entry-points/http/environment-controller/report-operation-state/endpoint.js';
import { PreviewStartupSweep } from './entry-points/startup/preview-startup-sweep.js';
import { EnvironmentFileSecretValues } from './infrastructure/adapters/environment-file-secret-values.js';
import { PrismaPreviewOperationLog } from './infrastructure/repositories/prisma-preview-operation-log.js';
import { PrismaPreviewOperationRepository } from './infrastructure/repositories/prisma-preview-operation-repository.js';
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
 * `environments` business module: a Project's Preview settings, and the work the environment
 * controller claims over the controller routes. It reaches the Repository only
 * through the `projects` module's public contract, which the composition root passes in.
 */
@Module({})
export class EnvironmentsModule {
  static register(projects: DynamicModule): DynamicModule {
    return {
      module: EnvironmentsModule,
      imports: [DatabaseModule, SecretsModule, projects],
      controllers: [
        GetPreviewEndpoint,
        SavePreviewSettingsEndpoint,
        RemovePreviewSettingsEndpoint,
        ClaimOperationEndpoint,
        ReportOperationStateEndpoint,
        AppendOperationLogEndpoint,
        GetOperationSourceEndpoint,
      ],
      providers: [
        { provide: PREVIEW_SETTINGS_REPOSITORY, useClass: PrismaPreviewSettingsRepository },
        {
          provide: PREVIEW_DOMAIN_SETTINGS,
          useFactory: (config: AppConfig): PreviewDomainSettings => ({
            domain: config.previewDomain,
          }),
          inject: [APP_CONFIG],
        },
        { provide: PREVIEW_OPERATION_REPOSITORY, useClass: PrismaPreviewOperationRepository },
        { provide: PREVIEW_OPERATION_LOG, useClass: PrismaPreviewOperationLog },
        { provide: PREVIEW_SECRET_VALUES, useClass: EnvironmentFileSecretValues },
        { provide: CLOCK, useValue: { now: () => new Date() } satisfies Clock },
        {
          provide: PREVIEW_LIMITS,
          useFactory: (config: AppConfig): PreviewLimitsSettings => ({ ...config.previewLimits }),
          inject: [APP_CONFIG],
        },
        {
          provide: PREVIEW_OPERATION_SETTINGS,
          useFactory: (config: AppConfig): PreviewOperationSettings => ({
            leaseSeconds: config.controllerLeaseSeconds,
            logMaxBytes: config.previewLogMaxBytes,
            snapshotGraceMs: PREVIEW_SNAPSHOT_GRACE_MS,
          }),
          inject: [APP_CONFIG],
        },
        GetPreviewHandler,
        RequestPreviewOperationHandler,
        ClaimPreviewOperationHandler,
        ReportPreviewOperationStateHandler,
        AppendPreviewOperationLogHandler,
        GetPreviewOperationSourceHandler,
        SweepPreviewEnvironmentFilesHandler,
        PreviewStartupSweep,
        SavePreviewSettingsHandler,
        RemovePreviewSettingsHandler,
      ],
    };
  }
}
