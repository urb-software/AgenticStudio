import { reportRunStateRequestSchema } from '@agentic-studio/contracts';
import { createZodDto } from 'nestjs-zod';

/** `POST /api/worker/runs/:runId/state` body: the shared worker protocol's schema (Issue #96). */
export class ReportRunStateRequestDto extends createZodDto(reportRunStateRequestSchema) {}
