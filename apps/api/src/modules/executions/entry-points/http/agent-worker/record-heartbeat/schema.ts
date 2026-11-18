import { heartbeatRequestSchema } from '@agentic-studio/contracts';
import { createZodDto } from 'nestjs-zod';

export class HeartbeatRequestDto extends createZodDto(heartbeatRequestSchema) {}
