import { appendRunEventsRequestSchema } from '@agentic-studio/contracts';
import { createZodDto } from 'nestjs-zod';

/** `POST /api/worker/runs/:runId/events` body: the shared worker protocol's schema (Issue #99). */
export class AppendRunEventsRequestDto extends createZodDto(appendRunEventsRequestSchema) {}
