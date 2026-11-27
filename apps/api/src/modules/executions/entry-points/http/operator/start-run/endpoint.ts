import { Body, Controller, HttpCode, HttpStatus, Param, Post } from '@nestjs/common';
import { ApiBody, ApiOperation, ApiTags } from '@nestjs/swagger';
import { ZodResponse } from 'nestjs-zod';
import {
  ApiProblemResponses,
  FieldProblemException,
  zodFieldErrors,
} from '../../../../../../platform/http/problem-details.js';
import {
  agentNotUsable,
  agentUnknown,
  definitionsProject,
  EXECUTIONS_PROBLEM_TYPES,
  projectNotFound,
  providerUnavailable,
  repositoryNotReady,
  workflowNotUsable,
  workflowUnknown,
} from '../../shared/problems.js';
import {
  AgentNotChosenError,
  AgentNotUsableError,
  AgentProviderMismatchError,
  AgentUnknownError,
  DefinitionsProjectRunError,
  RepositoryNotReadyError,
  RunProjectNotFoundError,
  ProviderUnavailableError,
  InvalidTaskError,
  WorkflowNotUsableError,
  WorkflowUnknownError,
} from '../../../../domain/errors/run-errors.js';
import { StartRunHandler } from '../../../../application/features/start-run/handler.js';
import { startRunRequestSchema, StartRunRequestDto, StartRunResponseDto } from './schema.js';

@ApiTags('runs')
@Controller('projects')
export class StartRunEndpoint {
  constructor(private readonly handler: StartRunHandler) {}

  @Post(':id/runs')
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ operationId: 'startRun' })
  @ApiBody({ type: StartRunRequestDto })
  @ZodResponse({ status: 201, type: StartRunResponseDto })
  @ApiProblemResponses({
    404: `Unknown project (${EXECUTIONS_PROBLEM_TYPES.projectNotFound})`,
    409:
      `The project is the definitions Repository (${EXECUTIONS_PROBLEM_TYPES.definitionsProject}; refused: run), ` +
      `or the project's repository is missing or not ready (${EXECUTIONS_PROBLEM_TYPES.repositoryNotReady}), ` +
      'or the provider is switched off on the agent worker or no agent worker is connected ' +
      `(${EXECUTIONS_PROBLEM_TYPES.providerUnavailable}; reason: provider_disabled), ` +
      `or no agent has the name (${EXECUTIONS_PROBLEM_TYPES.agentUnknown}; reason: agent_unknown), ` +
      'or its definition has problems ' +
      `(${EXECUTIONS_PROBLEM_TYPES.agentNotUsable}; reason: agent_not_usable), ` +
      `or no Workflow has the name (${EXECUTIONS_PROBLEM_TYPES.workflowUnknown}; reason: workflow_unknown), ` +
      'or the Workflow cannot be used, for instance because it has problems or a review Phase or starts with a Checkpoint ' +
      `(${EXECUTIONS_PROBLEM_TYPES.workflowNotUsable}; reason: workflow_not_usable)`,
    422: 'Invalid request body (field errors), also for a request naming both an agent and a Workflow, a Workflow with a provider, no choice at all while the project has no default, or an agent of another provider than the one named',
  })
  async start(@Param('id') projectId: string, @Body() body: unknown) {
    const parsed = startRunRequestSchema.safeParse(body);
    if (!parsed.success) {
      throw new FieldProblemException(
        HttpStatus.UNPROCESSABLE_ENTITY,
        'The request is invalid.',
        zodFieldErrors(parsed.error),
      );
    }
    try {
      return await this.handler.execute({ projectId, ...parsed.data });
    } catch (error) {
      if (error instanceof RunProjectNotFoundError) throw projectNotFound();
      if (error instanceof DefinitionsProjectRunError) throw definitionsProject();
      if (error instanceof RepositoryNotReadyError) throw repositoryNotReady(error.message);
      if (error instanceof ProviderUnavailableError) {
        throw providerUnavailable(error.reason, 'provider_disabled');
      }
      if (error instanceof WorkflowUnknownError) throw workflowUnknown();
      if (error instanceof WorkflowNotUsableError) throw workflowNotUsable(error.reason);
      if (error instanceof AgentUnknownError) throw agentUnknown();
      if (error instanceof AgentNotUsableError) throw agentNotUsable();
      if (error instanceof AgentNotChosenError) {
        throw new FieldProblemException(
          HttpStatus.UNPROCESSABLE_ENTITY,
          'The request is invalid.',
          [{ path: 'agent', message: error.message }],
        );
      }
      if (error instanceof AgentProviderMismatchError) {
        throw new FieldProblemException(
          HttpStatus.UNPROCESSABLE_ENTITY,
          'The request is invalid.',
          [{ path: 'provider', message: error.message }],
        );
      }
      // The schema reports these first; this keeps the Task's own rule the one that decides.
      if (error instanceof InvalidTaskError) {
        throw new FieldProblemException(
          HttpStatus.UNPROCESSABLE_ENTITY,
          'The request is invalid.',
          [{ path: 'task', message: error.message }],
        );
      }
      throw error;
    }
  }
}
