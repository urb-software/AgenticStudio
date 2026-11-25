import { Controller, Delete, HttpCode, HttpStatus, Param } from '@nestjs/common';
import { ApiNoContentResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { ApiProblemResponses } from '../../../../../../platform/http/problem-details.js';
import {
  definitionsProjectEnvironmentFile,
  PROJECTS_PROBLEM_TYPES,
  projectNotFound,
} from '../../shared/problems.js';
import { RemoveEnvironmentFileHandler } from '../../../../application/features/remove-environment-file/handler.js';
import {
  DefinitionsProjectError,
  ProjectNotFoundError,
} from '../../../../domain/errors/project-errors.js';

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
  @ApiProblemResponses({
    404: `Unknown project (${PROJECTS_PROBLEM_TYPES.projectNotFound})`,
    409: `The project is the definitions Repository (${PROJECTS_PROBLEM_TYPES.definitionsProject}; refused: environment_file)`,
  })
  async remove(@Param('id') id: string): Promise<void> {
    try {
      await this.handler.execute({ projectId: id });
    } catch (error) {
      if (error instanceof ProjectNotFoundError) throw projectNotFound();
      if (error instanceof DefinitionsProjectError) throw definitionsProjectEnvironmentFile();
      throw error;
    }
  }
}
