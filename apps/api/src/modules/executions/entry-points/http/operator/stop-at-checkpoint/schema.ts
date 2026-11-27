import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

export const stopAtCheckpointRequestSchema = z
  .strictObject({
    checkpoint: z
      .string()
      .min(1)
      .max(64)
      .optional()
      .describe(
        'The id of the Checkpoint the operator saw; another one is refused as not_at_checkpoint.',
      ),
  })
  .meta({ id: 'StopAtCheckpointRequest' });

export class StopAtCheckpointRequestDto extends createZodDto(stopAtCheckpointRequestSchema) {}
