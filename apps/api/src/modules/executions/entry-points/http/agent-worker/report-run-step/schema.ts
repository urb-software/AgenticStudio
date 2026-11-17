import { reportRunStepRequestSchema } from '@agentic-studio/contracts';
import { createZodDto } from 'nestjs-zod';

/** `POST /api/worker/runs/:runId/steps` body: the shared worker protocol's schema (Issue #96). */
export class ReportRunStepRequestDto extends createZodDto(reportRunStepRequestSchema) {}
