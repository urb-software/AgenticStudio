import { Injectable, type OnApplicationBootstrap } from '@nestjs/common';
import { SweepPreviewEnvironmentFilesHandler } from '../../application/features/sweep-preview-environment-files/handler.js';

@Injectable()
export class PreviewStartupSweep implements OnApplicationBootstrap {
  constructor(private readonly snapshots: SweepPreviewEnvironmentFilesHandler) {}

  async onApplicationBootstrap(): Promise<void> {
    await this.snapshots.execute();
  }
}
