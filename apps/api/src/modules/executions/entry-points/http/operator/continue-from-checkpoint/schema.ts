import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

/** Longest note the operator may give the next Phase, in characters. */
export const CHECKPOINT_COMMENT_MAX_LENGTH = 4000;

export const continueFromCheckpointRequestSchema = z
  .strictObject({
    comment: z
      .string()
      .trim()
      .max(CHECKPOINT_COMMENT_MAX_LENGTH, {
        error: `Use at most ${CHECKPOINT_COMMENT_MAX_LENGTH} characters.`,
      })
      .optional()
      .describe('A note for the next Phase, given to the agent as untrusted text.'),
    checkpoint: z
      .string()
      .min(1)
      .max(64)
      .optional()
      .describe(
        'The id of the Checkpoint the operator saw; another one is refused as not_at_checkpoint, so a repeated request cannot pass the next Checkpoint.',
      ),
  })
  .meta({ id: 'ContinueFromCheckpointRequest' });

export class ContinueFromCheckpointRequestDto extends createZodDto(
  continueFromCheckpointRequestSchema,
) {}
