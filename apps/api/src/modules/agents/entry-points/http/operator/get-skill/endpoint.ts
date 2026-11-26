import { AGENT_NAME_PATTERN } from '@agentic-studio/agent-definitions';
import { Controller, Get, Param } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { ZodResponse } from 'nestjs-zod';
import { ApiProblemResponses } from '../../../../../../platform/http/problem-details.js';
import { ReadSkillsHandler } from '../../../../application/features/read-skills/handler.js';
import { AGENTS_PROBLEM_TYPES, skillNotFound } from '../../shared/problems.js';
import { toSkillsRepository, toSkillSummary } from '../../shared/skill-response.js';
import { SkillDetailResponseDto } from './schema.js';

/** `GET /api/skills/:name`, behind the global session guard: an operator route only. */
@ApiTags('agents')
@Controller('skills')
export class GetSkillEndpoint {
  constructor(private readonly handler: ReadSkillsHandler) {}

  @Get(':name')
  @ApiOperation({
    operationId: 'getSkill',
    description:
      'One skill with its instructions (plain text) and the files of its folder with their ' +
      'sizes, read at the last fetched commit of the definitions Repository. A name that is not ' +
      'a valid skill name is unknown. The Draft is never read.',
  })
  @ZodResponse({ status: 200, type: SkillDetailResponseDto })
  @ApiProblemResponses({ 404: `Unknown skill (${AGENTS_PROBLEM_TYPES.skillNotFound})` })
  async get(@Param('name') name: string) {
    if (!AGENT_NAME_PATTERN.test(name)) throw skillNotFound();
    const result = await this.handler.execute({ name });
    const skill = result.skills[0];
    if (!skill) throw skillNotFound();
    return {
      commit: result.commit,
      repository: toSkillsRepository(result.repository),
      ...toSkillSummary(skill),
      instructions: skill.instructions,
      files: skill.files,
    };
  }
}
