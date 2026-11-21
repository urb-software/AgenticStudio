import { setMergeMethodRequestSchema } from '@agentic-studio/contracts';
import { createZodDto } from 'nestjs-zod';

export class SetMergeMethodRequestDto extends createZodDto(
  setMergeMethodRequestSchema.meta({ id: 'SetMergeMethodRequest' }),
) {}
