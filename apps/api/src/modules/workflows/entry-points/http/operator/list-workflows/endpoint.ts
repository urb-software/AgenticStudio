import { Controller, Get } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { ZodResponse } from 'nestjs-zod';
import { ReadWorkflowsHandler } from '../../../../application/features/read-workflows/handler.js';
import { toWorkflowsRepository, toWorkflowSummary } from '../../shared/workflow-response.js';
import { WorkflowListResponseDto } from './schema.js';

/** `GET /api/workflows`, behind the global session guard: an operator route only. */
@ApiTags('workflows')
@Controller('workflows')
export class ListWorkflowsEndpoint {
  constructor(private readonly handler: ReadWorkflowsHandler) {}

  @Get()
  @ApiOperation({
    operationId: 'listWorkflows',
    description:
      'The Workflow folders of the definitions Repository at its last fetched commit, each with ' +
      'its problems, whether it is valid and whether it can be chosen now (a phase whose agent ' +
      'uses a Provider that is not available makes a valid Workflow not usable). At most 200 are ' +
      'listed. The Draft is never read.',
  })
  @ZodResponse({ status: 200, type: WorkflowListResponseDto })
  async list() {
    const result = await this.handler.execute();
    return {
      commit: result.commit,
      repository: toWorkflowsRepository(result.repository),
      truncated: result.truncated,
      workflows: result.workflows.map(toWorkflowSummary),
    };
  }
}
