import { Inject, Injectable } from '@nestjs/common';
import { PROJECT_KINDS, type ProjectKinds } from '../../../../projects/contracts/index.js';
import { DefinitionsProjectError } from '../../../domain/errors/preview-settings-errors.js';
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
 * Throws `DefinitionsProjectError` and the refusals of `PreviewBuildRequests`: not found, settings, Repository, controller,
 * build running, busy, limit reached, refused file and unreadable source.
 */
@Injectable()
export class RequestPreviewBuildHandler {
  constructor(
    @Inject(PROJECT_KINDS) private readonly kinds: ProjectKinds,
    private readonly builds: PreviewBuildRequests,
  ) {}

  async execute(input: RequestPreviewBuildInput): Promise<RequestPreviewBuildResult> {
    const { projectId } = input;
    if ((await this.kinds.kindOf(projectId)) === 'definitions') throw new DefinitionsProjectError();
    const prepared = await this.builds.prepareFromSettings(projectId);
    const operation = await this.builds.request(prepared);
    return { operationId: operation.id, build: previewBuildView(operation) };
  }
}
