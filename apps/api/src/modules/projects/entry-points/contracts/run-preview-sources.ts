import { Injectable } from '@nestjs/common';
import type {
  IntegrationFileResult,
  PreviewArchiveResult,
  PreviewSourceStatus,
  RunPreviewSources,
} from '../../contracts/index.js';
import { GetPreviewSourceStatusHandler } from '../../application/features/get-preview-source-status/handler.js';
import { OpenPreviewArchiveHandler } from '../../application/features/open-preview-archive/handler.js';
import { ReadIntegrationFileHandler } from '../../application/features/read-integration-file/handler.js';

/**
 * The driving adapter for another module's call through `contracts/`: it maps the call to the
 * handlers and holds no rule.
 */
@Injectable()
export class ProjectRunPreviewSources implements RunPreviewSources {
  constructor(
    private readonly statusHandler: GetPreviewSourceStatusHandler,
    private readonly readHandler: ReadIntegrationFileHandler,
    private readonly archiveHandler: OpenPreviewArchiveHandler,
  ) {}

  status(projectId: string): Promise<PreviewSourceStatus> {
    return this.statusHandler.execute({ projectId });
  }

  readIntegrationFile(projectId: string, path: string): Promise<IntegrationFileResult> {
    return this.readHandler.execute({ projectId, path });
  }

  openArchive(projectId: string, commit: string, maxBytes: number): Promise<PreviewArchiveResult> {
    return this.archiveHandler.execute({ projectId, commit, maxBytes });
  }
}
