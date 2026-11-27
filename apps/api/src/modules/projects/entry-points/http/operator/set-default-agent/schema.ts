import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';
import { AgentName } from '../../../../domain/value-objects/agent-name.js';

export const setDefaultAgentRequestSchema = z
  .strictObject({
    agent: z
      .string()
      .regex(AgentName.PATTERN, { error: 'Use lower-case letters, digits and "-" (at most 64).' })
      .nullable()
      .optional()
      .describe('The agent a Run offers first, by name; null names none.'),
    workflow: z
      .string()
      .regex(AgentName.PATTERN, { error: 'Use lower-case letters, digits and "-" (at most 64).' })
      .nullable()
      .optional()
      .describe('The Workflow a Run offers first, by name; null names none.'),
  })
  .refine((request) => request.agent === undefined || request.agent === null || !request.workflow, {
    path: ['workflow'],
    message: 'Name an agent or a Workflow, not both.',
  })
  .refine((request) => request.agent !== undefined || request.workflow !== undefined, {
    path: ['agent'],
    message: 'Name an agent or a Workflow, or null for none.',
  })
  .meta({ id: 'SetDefaultAgentRequest' });

export class SetDefaultAgentRequestDto extends createZodDto(setDefaultAgentRequestSchema) {}
