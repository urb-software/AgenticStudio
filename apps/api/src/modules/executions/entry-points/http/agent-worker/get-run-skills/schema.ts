import { runSkillsQuerySchema } from '@agentic-studio/contracts';
import { createZodDto } from 'nestjs-zod';

export class RunSkillsQueryDto extends createZodDto(runSkillsQuerySchema) {}
