import { AGENT_NAME_PATTERN } from '@agentic-studio/agent-definitions';
import { Controller, Get, Param } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { ZodResponse } from 'nestjs-zod';
import { ApiProblemResponses } from '../../../../../../platform/http/problem-details.js';
import { ReadWorkflowHandler } from '../../../../application/features/read-workflow/handler.js';
import { WORKFLOWS_PROBLEM_TYPES, workflowNotFound } from '../../shared/problems.js';
import {
  toWorkflowItem,
  toWorkflowsRepository,
  toWorkflowSummary,
} from '../../shared/workflow-response.js';
import { WorkflowDetailResponseDto } from './schema.js';

/** `GET /api/workflows/:name`, behind the global session guard: an operator route only. */
@ApiTags('workflows')
@Controller('workflows')
export class GetWorkflowEndpoint {
  constructor(private readonly handler: ReadWorkflowHandler) {}

  @Get(':name')
  @ApiOperation({
    operationId: 'getWorkflow',
    description:
      'One Workflow with its phases and checkpoints in order, each phase with its agent, the ' +
      'state of that agent and whether it can be used now, and the send-back limit, read at the ' +
      'last fetched commit of the definitions Repository. A name that is not a valid Workflow ' +
      'name is unknown and reads nothing. The Draft is never read.',
  })
  @ZodResponse({ status: 200, type: WorkflowDetailResponseDto })
  @ApiProblemResponses({ 404: `Unknown Workflow (${WORKFLOWS_PROBLEM_TYPES.workflowNotFound})` })
  async get(@Param('name') name: string) {
    if (!AGENT_NAME_PATTERN.test(name)) throw workflowNotFound();
    const result = await this.handler.execute({ name });
    if (!result.workflow) throw workflowNotFound();
    return {
      commit: result.commit,
      repository: toWorkflowsRepository(result.repository),
      ...toWorkflowSummary(result.workflow),
      sendBacks: result.workflow.sendBacks,
      items: result.workflow.items.map(toWorkflowItem),
    };
  }
}
