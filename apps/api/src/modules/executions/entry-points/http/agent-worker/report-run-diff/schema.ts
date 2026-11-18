import { reportRunDiffRequestSchema } from '@agentic-studio/contracts';
import { createZodDto } from 'nestjs-zod';

export class ReportRunDiffRequestDto extends createZodDto(reportRunDiffRequestSchema) {}
