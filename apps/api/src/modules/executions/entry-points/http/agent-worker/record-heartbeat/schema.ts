import { heartbeatRequestSchema } from '@agentic-studio/contracts';
import { createZodDto } from 'nestjs-zod';

/** `POST /api/worker/runs/:runId/heartbeat` body: the shared worker protocol's schema (Issue #96). */
export class HeartbeatRequestDto extends createZodDto(heartbeatRequestSchema) {}
