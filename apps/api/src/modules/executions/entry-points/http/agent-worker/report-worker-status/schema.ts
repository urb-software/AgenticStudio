import { workerStatusRequestSchema } from '@agentic-studio/contracts';
import { createZodDto } from 'nestjs-zod';

/** `POST /api/worker/status` body: the shared worker protocol's schema (Issue #101). */
export class WorkerStatusRequestDto extends createZodDto(workerStatusRequestSchema) {}
