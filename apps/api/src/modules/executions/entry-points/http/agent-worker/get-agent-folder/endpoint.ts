import { type AgentFolderResponse, agentFolderResponseSchema } from '@agentic-studio/contracts';
import { Get, Param, Query } from '@nestjs/common';
import { WorkerController } from '../../../../../../platform/auth/worker-route.js';
import { GetAgentFolderHandler } from '../../../../application/features/get-agent-folder/handler.js';
import {
  AgentFolderInvalidError,
  AgentFolderUnavailableError,
  RunNotFoundError,
  RunNotHeldError,
} from '../../../../domain/errors/run-errors.js';
import { agentFolderInvalid, agentFolderUnavailable, runNotFound } from '../../shared/problems.js';
import { AgentFolderQueryDto } from './schema.js';

@WorkerController('runs')
export class GetAgentFolderEndpoint {
  constructor(private readonly handler: GetAgentFolderHandler) {}

  @Get(':runId/agent-folder')
  async agentFolder(
    @Param('runId') runId: string,
    @Query() query: AgentFolderQueryDto,
  ): Promise<AgentFolderResponse> {
    try {
      const folder = await this.handler.execute({ runId, workerId: query.workerId });
      return agentFolderResponseSchema.parse({
        commit: folder.commit,
        files: folder.files.map((file) => ({
          path: file.path,
          executable: file.executable,
          contentBase64: Buffer.from(file.content).toString('base64'),
        })),
      });
    } catch (error) {
      // Another worker's Run looks like no Run at all.
      if (error instanceof RunNotFoundError || error instanceof RunNotHeldError) {
        throw runNotFound();
      }
      if (error instanceof AgentFolderUnavailableError) throw agentFolderUnavailable();
      if (error instanceof AgentFolderInvalidError) throw agentFolderInvalid(error.detail);
      throw error;
    }
  }
}
