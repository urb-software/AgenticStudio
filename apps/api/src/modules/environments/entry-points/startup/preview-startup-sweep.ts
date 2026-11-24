import { Injectable, type OnApplicationBootstrap } from '@nestjs/common';
import { SweepPreviewEnvironmentFilesHandler } from '../../application/features/sweep-preview-environment-files/handler.js';

/** Removes Environment file snapshots no operation references, once the API has started. */
@Injectable()
export class PreviewStartupSweep implements OnApplicationBootstrap {
  constructor(private readonly snapshots: SweepPreviewEnvironmentFilesHandler) {}

  async onApplicationBootstrap(): Promise<void> {
    await this.snapshots.execute();
  }
}
