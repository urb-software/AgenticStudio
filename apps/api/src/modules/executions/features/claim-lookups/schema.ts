import { claimLookupsRequestSchema } from '@agentic-studio/contracts';
import { createZodDto } from 'nestjs-zod';

/** `POST /api/worker/lookups/claim` body: the shared worker protocol's schema (Issue #142). */
export class ClaimLookupsRequestDto extends createZodDto(claimLookupsRequestSchema) {}
