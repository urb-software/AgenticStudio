import { Injectable } from '@nestjs/common';
import { type PreviewBuildView, previewBuildView } from '../../preview-view.js';
import { PreviewBuildRequests } from '../../preview-build-requests.js';

export interface RequestPreviewBuildInput {
  projectId: string;
}

export interface RequestPreviewBuildResult {
  operationId: string;
  build: PreviewBuildView;
}

/**
 * Asks the controller to build and start the Preview, checking as backend.md section 7 lists.
 * Throws the refusals of `PreviewBuildRequests`: not found, settings, Repository, controller,
 * build running, busy, limit reached, refused file and unreadable source.
 */
@Injectable()
export class RequestPreviewBuildHandler {
  constructor(private readonly builds: PreviewBuildRequests) {}

  async execute(input: RequestPreviewBuildInput): Promise<RequestPreviewBuildResult> {
    const prepared = await this.builds.prepareFromSettings(input.projectId);
    const operation = await this.builds.request(prepared);
    return { operationId: operation.id, build: previewBuildView(operation) };
  }
}
