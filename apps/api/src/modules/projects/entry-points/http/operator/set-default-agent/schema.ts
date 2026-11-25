import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';
import { AgentName } from '../../../../domain/value-objects/agent-name.js';

export const setDefaultAgentRequestSchema = z
  .strictObject({
    agent: z
      .string()
      .regex(AgentName.PATTERN, { error: 'Use lower-case letters, digits and "-" (at most 64).' })
      .nullable()
      .describe('The agent a Run offers first, by name; null names none.'),
  })
  .meta({ id: 'SetDefaultAgentRequest' });

export class SetDefaultAgentRequestDto extends createZodDto(setDefaultAgentRequestSchema) {}
