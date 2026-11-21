import { mergeRunRequestSchema, mergeRunResponseSchema } from '@agentic-studio/contracts';
import { createZodDto } from 'nestjs-zod';

export { mergeRunRequestSchema };

export class MergeRunRequestDto extends createZodDto(
  mergeRunRequestSchema.meta({ id: 'MergeRunRequest' }),
) {}

export class MergeRunResponseDto extends createZodDto(
  mergeRunResponseSchema.meta({ id: 'MergeRunResponse' }),
) {}
