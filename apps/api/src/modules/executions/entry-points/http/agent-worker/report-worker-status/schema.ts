import { workerStatusRequestSchema } from '@agentic-studio/contracts';
import { createZodDto } from 'nestjs-zod';

export class WorkerStatusRequestDto extends createZodDto(workerStatusRequestSchema) {}
