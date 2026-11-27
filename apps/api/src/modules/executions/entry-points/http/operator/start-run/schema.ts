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
    workflow: z
      .string()
      .min(1)
      .max(RUN_AGENT_NAME_MAX_LENGTH)
      .optional()
      .describe(
        'The Workflow to start with, by name, in place of an agent. With neither an agent, a ' +
          "Workflow nor a provider, the project's default is started.",
      ),
    provider: z
      .enum(PROVIDERS)
      .optional()
      .describe(
        'Alone, it means the Default agent of this Provider. With an `agent`, it must be the ' +
          "agent's Provider.",
      ),
  })
  .refine((request) => request.agent === undefined || request.workflow === undefined, {
    path: ['workflow'],
    message: 'Name an agent or a Workflow, not both.',
  })
  .refine((request) => request.workflow === undefined || request.provider === undefined, {
    path: ['provider'],
    message: 'A Workflow names its own providers.',
  })
  .meta({ id: 'StartRunRequest' });

export class StartRunRequestDto extends createZodDto(startRunRequestSchema) {}

export const startRunResponseSchema = z
  .strictObject({
    id: z.uuid(),
  })
  .meta({ id: 'StartRunResponse' });

export class StartRunResponseDto extends createZodDto(startRunResponseSchema) {}
