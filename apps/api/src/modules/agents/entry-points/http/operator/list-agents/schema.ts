import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';
import {
  agentsCommitSchema,
  agentsRepositorySchema,
  agentSummarySchema,
} from '../../shared/agent-response.js';

export const agentListResponseSchema = z
  .object({
    commit: agentsCommitSchema,
    repository: agentsRepositorySchema
      .nullable()
      .describe('Null when no definitions Repository is connected.'),
    truncated: z.boolean().describe('True when more agent folders exist than are listed.'),
    baseRules: z
      .object({
        version: z.string(),
        text: z
          .string()
          .describe('Plain text, not Markdown. The instructions of an agent come after.'),
      })
      .describe('The rules every Run gets before the instructions of its agent. Read-only.'),
    agents: z.array(agentSummarySchema),
  })
  .meta({ id: 'AgentList' });

export class AgentListResponseDto extends createZodDto(agentListResponseSchema) {}
