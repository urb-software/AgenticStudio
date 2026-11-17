import { Controller, Delete, HttpCode, HttpStatus, Param } from '@nestjs/common';
import { ApiNoContentResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { ApiProblemResponses } from '../../../../../../platform/http/problem-details.js';
import { PROJECTS_PROBLEM_TYPES, projectNotFound } from '../../shared/problems.js';
import { ProjectNotFoundError } from '../../../../domain/repositories/project-repository.js';
import { RemoveEnvironmentFileHandler } from '../../../../application/features/remove-environment-file/handler.js';

/**
 * `DELETE /api/projects/:id/environment-file` (Issue #104), behind the global session and
 * mutation Origin guards. The confirm dialog in the web app is the operator's authorization.
 */
@ApiTags('projects')
@Controller('projects')
export class RemoveEnvironmentFileEndpoint {
  constructor(private readonly handler: RemoveEnvironmentFileHandler) {}

  @Delete(':id/environment-file')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({
    operationId: 'removeEnvironmentFile',
    description:
      "Removes the project's Environment file and deletes its content from the secret store. " +
      'Runs prepared afterwards get none; Runs already claimed keep theirs. Removing a file ' +
      'that is not set changes nothing.',
  })
  @ApiNoContentResponse({ description: 'Removed (or there was none)' })
  @ApiProblemResponses({ 404: `Unknown project (${PROJECTS_PROBLEM_TYPES.projectNotFound})` })
  async remove(@Param('id') id: string): Promise<void> {
    try {
      await this.handler.execute(id);
    } catch (error) {
      if (error instanceof ProjectNotFoundError) throw projectNotFound();
      throw error;
    }
  }
}
