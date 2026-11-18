import { reportRunStepRequestSchema } from '@agentic-studio/contracts';
import { createZodDto } from 'nestjs-zod';

export class ReportRunStepRequestDto extends createZodDto(reportRunStepRequestSchema) {}
