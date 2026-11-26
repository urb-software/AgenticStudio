import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';
import {
  skillsCommitSchema,
  skillsRepositorySchema,
  skillSummaryFields,
} from '../../shared/skill-response.js';

export const skillDetailResponseSchema = z
  .object({
    commit: skillsCommitSchema,
    repository: skillsRepositorySchema
      .nullable()
      .describe('Null when no definitions Repository is connected.'),
    ...skillSummaryFields,
    instructions: z
      .string()
      .describe('Plain text, never Markdown or HTML to render; empty for an invalid skill.'),
    files: z
      .array(z.object({ path: z.string(), size: z.number().int().min(0) }))
      .describe('Every file of the skill folder with its size in bytes.'),
  })
  .meta({ id: 'SkillDetail' });

export class SkillDetailResponseDto extends createZodDto(skillDetailResponseSchema) {}
