import { type RunSkillsResponse, runSkillsResponseSchema } from '@agentic-studio/contracts';
import { Get, Param, Query } from '@nestjs/common';
import { WorkerController } from '../../../../../../platform/auth/worker-route.js';
import { GetRunSkillsHandler } from '../../../../application/features/get-run-skills/handler.js';
import {
  RunNotFoundError,
  RunNotHeldError,
  SkillsInvalidError,
  SkillsReadFailedError,
  SkillsUnavailableError,
} from '../../../../domain/errors/run-errors.js';
import {
  runNotFound,
  runNotHeld,
  skillsInvalid,
  skillsReadFailed,
  skillsUnavailable,
} from '../../shared/problems.js';
import { RunSkillsQueryDto } from './schema.js';

@WorkerController('runs')
export class GetRunSkillsEndpoint {
  constructor(private readonly handler: GetRunSkillsHandler) {}

  @Get(':runId/skills')
  async skills(
    @Param('runId') runId: string,
    @Query() query: RunSkillsQueryDto,
  ): Promise<RunSkillsResponse> {
    try {
      const result = await this.handler.execute({ runId, workerId: query.workerId });
      return runSkillsResponseSchema.parse({
        commit: result.commit,
        skills: result.skills.map((skill) => ({
          name: skill.name,
          files: skill.files.map((file) => ({
            path: file.path,
            executable: file.executable,
            contentBase64: Buffer.from(file.content).toString('base64'),
          })),
        })),
        omitted: result.omitted,
      });
    } catch (error) {
      if (error instanceof RunNotFoundError) throw runNotFound();
      if (error instanceof RunNotHeldError) throw runNotHeld();
      if (error instanceof SkillsReadFailedError) throw skillsReadFailed();
      if (error instanceof SkillsUnavailableError) throw skillsUnavailable();
      if (error instanceof SkillsInvalidError) throw skillsInvalid(error.detail);
      throw error;
    }
  }
}
