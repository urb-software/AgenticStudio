import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';
import {
  skillsCommitSchema,
  skillsRepositorySchema,
  skillSummaryFields,
} from '../../shared/skill-response.js';

export const skillListResponseSchema = z
  .object({
    commit: skillsCommitSchema,
    repository: skillsRepositorySchema
      .nullable()
      .describe('Null when no definitions Repository is connected.'),
    truncated: z.boolean().describe('True when more skill folders exist than are listed.'),
    skills: z.array(z.object(skillSummaryFields).meta({ id: 'SkillSummary' })),
  })
  .meta({ id: 'SkillList' });

export class SkillListResponseDto extends createZodDto(skillListResponseSchema) {}
