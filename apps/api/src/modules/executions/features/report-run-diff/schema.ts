import { reportRunDiffRequestSchema } from '@agentic-studio/contracts';
import { createZodDto } from 'nestjs-zod';

/** `POST /api/worker/runs/:runId/diff` body: the shared worker protocol's schema (Issue #144). */
export class ReportRunDiffRequestDto extends createZodDto(reportRunDiffRequestSchema) {}
