import { claimRunRequestSchema } from '@agentic-studio/contracts';
import { createZodDto } from 'nestjs-zod';

export class ClaimRunRequestDto extends createZodDto(claimRunRequestSchema) {}
