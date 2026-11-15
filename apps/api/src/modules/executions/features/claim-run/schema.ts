import { claimRunRequestSchema } from '@agentic-studio/contracts';
import { createZodDto } from 'nestjs-zod';

/** `POST /api/worker/runs/claim` body: the shared worker protocol's schema (Issue #96). */
export class ClaimRunRequestDto extends createZodDto(claimRunRequestSchema) {}
