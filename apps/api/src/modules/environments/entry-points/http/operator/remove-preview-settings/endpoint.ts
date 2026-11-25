import { Controller, Delete, HttpCode, HttpStatus, Param } from '@nestjs/common';
import { ApiNoContentResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { ApiProblemResponses } from '../../../../../../platform/http/problem-details.js';
import { RemovePreviewSettingsHandler } from '../../../../application/features/remove-preview-settings/handler.js';
import {
  DefinitionsProjectError,
  PreviewBuildRunningError,
  PreviewRunningError,
  ProjectNotFoundError,
} from '../../../../domain/errors/preview-settings-errors.js';
import {
  buildRunning,
  definitionsProject,
  ENVIRONMENTS_PROBLEM_TYPES,
  previewRunning,
  projectNotFound,
} from '../../shared/problems.js';

/** `DELETE /api/projects/:id/preview/settings`, behind the global session and mutation Origin guards. */
@ApiTags('environments')
@Controller('projects')
export class RemovePreviewSettingsEndpoint {
  constructor(private readonly handler: RemovePreviewSettingsHandler) {}

  @Delete(':id/preview/settings')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({
    operationId: 'removePreviewSettings',
    description:
      "Removes the project's Preview settings. Removing settings that are not set changes nothing.",
  })
  @ApiNoContentResponse({ description: 'Removed (or there were none)' })
  @ApiProblemResponses({
    404: `Unknown project (${ENVIRONMENTS_PROBLEM_TYPES.projectNotFound})`,
    409:
      `The project is the definitions Repository (${ENVIRONMENTS_PROBLEM_TYPES.definitionsProject}; refused: preview), ` +
      `The Preview is running (${ENVIRONMENTS_PROBLEM_TYPES.previewRunning}) or a build is ` +
      `running (${ENVIRONMENTS_PROBLEM_TYPES.buildRunning})`,
  })
  async remove(@Param('id') id: string): Promise<void> {
    try {
      await this.handler.execute({ projectId: id });
    } catch (error) {
      if (error instanceof ProjectNotFoundError) throw projectNotFound();
      if (error instanceof DefinitionsProjectError) throw definitionsProject();
      if (error instanceof PreviewRunningError) throw previewRunning();
      if (error instanceof PreviewBuildRunningError) throw buildRunning();
      throw error;
    }
  }
}
