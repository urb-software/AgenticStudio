import { runStatesRequestSchema } from '@agentic-studio/contracts';
import { createZodDto } from 'nestjs-zod';

/** `POST /api/worker/runs/states` body: the shared worker protocol's schema (Issue #98). */
export class RunStatesRequestDto extends createZodDto(runStatesRequestSchema) {}
