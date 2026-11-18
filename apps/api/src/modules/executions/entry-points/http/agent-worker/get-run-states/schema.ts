import { runStatesRequestSchema } from '@agentic-studio/contracts';
import { createZodDto } from 'nestjs-zod';

export class RunStatesRequestDto extends createZodDto(runStatesRequestSchema) {}
