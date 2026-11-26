import { Controller, Get } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { ZodResponse } from 'nestjs-zod';
import { ReadSkillsHandler } from '../../../../application/features/read-skills/handler.js';
import { toSkillsRepository, toSkillSummary } from '../../shared/skill-response.js';
import { SkillListResponseDto } from './schema.js';

/** `GET /api/skills`, behind the global session guard: an operator route only. */
@ApiTags('agents')
@Controller('skills')
export class ListSkillsEndpoint {
  constructor(private readonly handler: ReadSkillsHandler) {}

  @Get()
  @ApiOperation({
    operationId: 'listSkills',
    description:
      'The skill folders of the definitions Repository at its last fetched commit, each with ' +
      'its problems and whether it is valid. At most 200 are listed. The Draft is never read.',
  })
  @ZodResponse({ status: 200, type: SkillListResponseDto })
  async list() {
    const result = await this.handler.execute();
    return {
      commit: result.commit,
      repository: toSkillsRepository(result.repository),
      truncated: result.truncated,
      skills: result.skills.map(toSkillSummary),
    };
  }
}
