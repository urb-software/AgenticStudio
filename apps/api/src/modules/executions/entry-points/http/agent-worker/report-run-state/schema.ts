import { reportRunStateRequestSchema } from '@agentic-studio/contracts';
import { createZodDto } from 'nestjs-zod';

export class ReportRunStateRequestDto extends createZodDto(reportRunStateRequestSchema) {}
