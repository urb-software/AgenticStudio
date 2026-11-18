import { appendRunEventsRequestSchema } from '@agentic-studio/contracts';
import { createZodDto } from 'nestjs-zod';

export class AppendRunEventsRequestDto extends createZodDto(appendRunEventsRequestSchema) {}
