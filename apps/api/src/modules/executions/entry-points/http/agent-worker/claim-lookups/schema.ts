import { claimLookupsRequestSchema } from '@agentic-studio/contracts';
import { createZodDto } from 'nestjs-zod';

export class ClaimLookupsRequestDto extends createZodDto(claimLookupsRequestSchema) {}
