import { PROVIDERS } from '@agentic-studio/agent-definitions';
import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

export const runAgentOptionSchema = z
  .object({
    name: z.string(),
    description: z.string().nullable(),
    provider: z.enum(PROVIDERS).describe('The Provider follows from the agent.'),
    model: z.string().describe('The model the agent names; `default` is the CLI own.'),
    source: z.enum(['built_in', 'definitions']),
  })
  .meta({ id: 'RunAgentOption' });

export const runAgentListResponseSchema = z
  .object({
    agents: z
      .array(runAgentOptionSchema)
      .describe('The usable agents: the built-in Default agents, then the definitions agents.'),
    preselected: z
      .string()
      .describe('The name of the agent to offer first, always one of `agents`.'),
    preselectedReason: z
      .string()
      .nullable()
      .describe(
        'Why the default agent of the project is not the preselected one; null when it is, or none is named.',
      ),
  })
  .meta({ id: 'RunAgentList' });

export class RunAgentListResponseDto extends createZodDto(runAgentListResponseSchema) {}
