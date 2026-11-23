import { PreviewRunningError } from '../errors/preview-settings-errors.js';
import type { PreviewComposeFile } from '../value-objects/preview-compose-file.js';
import type { PreviewPort } from '../value-objects/preview-port.js';
import type { PreviewService } from '../value-objects/preview-service.js';
import type { PreviewSettingsData } from './preview-settings-data.js';
import type { PreviewSettingsRemovalFacts } from './preview-settings-removal-facts.js';

/**
 * A Project's Preview settings: the Compose file and the service and port its Preview routes to.
 * Made only by {@link PreviewSettings.create} or {@link PreviewSettings.restore}.
 */
export class PreviewSettings {
  readonly projectId: string;
  readonly composeFile: string;
  readonly service: string;
  readonly port: number;
  readonly updatedAt: Date;

  private constructor(data: PreviewSettingsData) {
    this.projectId = data.projectId;
    this.composeFile = data.composeFile;
    this.service = data.service;
    this.port = data.port;
    this.updatedAt = new Date(data.updatedAt);
  }

  static create(input: {
    projectId: string;
    composeFile: PreviewComposeFile;
    service: PreviewService;
    port: PreviewPort;
    now: Date;
  }): PreviewSettings {
    return new PreviewSettings({
      projectId: input.projectId,
      composeFile: input.composeFile.value,
      service: input.service.value,
      port: input.port.value,
      updatedAt: input.now,
    });
  }

  static restore(data: PreviewSettingsData): PreviewSettings {
    return new PreviewSettings(data);
  }

  /** Checks that the settings may be removed; the caller then deletes them. Throws {@link PreviewRunningError}. */
  remove(facts: PreviewSettingsRemovalFacts): void {
    if (facts.previewRunning) throw new PreviewRunningError();
  }
}
