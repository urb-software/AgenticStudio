import { RUN_AGENT_NAME_MAX_LENGTH } from '@agentic-studio/contracts';
import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';
import { PROVIDERS } from '../../../../domain/value-objects/provider.js';
import { TASK_MAX_LENGTH } from '../../../../domain/value-objects/task.js';

/**
 * Counted in UTF-16 code units; PostgreSQL VARCHAR(20000) counts characters, so a
 * valid Task always fits.
 */
export const startRunRequestSchema = z
  .strictObject({
    task: z
      .string()
      .trim()
      .min(1, { error: 'Enter a task.' })
      .max(TASK_MAX_LENGTH, { error: `Use at most ${TASK_MAX_LENGTH} characters.` }),
    agent: z
      .string()
      .min(1)
      .max(RUN_AGENT_NAME_MAX_LENGTH)
      .optional()
      .describe('The agent to start with, by name. Absent: the Default agent of `provider`.'),
    provider: z
      .enum(PROVIDERS)
      .optional()
      .describe(
        'Alone, it means the Default agent of this Provider. With an `agent`, it must be the ' +
          "agent's Provider.",
      ),
  })
  .refine((request) => request.agent !== undefined || request.provider !== undefined, {
    path: ['agent'],
    message: 'Name an agent or a provider.',
  })
  .meta({ id: 'StartRunRequest' });

export class StartRunRequestDto extends createZodDto(startRunRequestSchema) {}

export const startRunResponseSchema = z
  .strictObject({
    id: z.uuid(),
  })
  .meta({ id: 'StartRunResponse' });

export class StartRunResponseDto extends createZodDto(startRunResponseSchema) {}
