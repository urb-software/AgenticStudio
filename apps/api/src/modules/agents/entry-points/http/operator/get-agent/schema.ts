import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';
import {
  agentsCommitSchema,
  agentsRepositorySchema,
  agentSummarySchema,
} from '../../shared/agent-response.js';

export const agentDetailResponseSchema = z
  .object({
    commit: agentsCommitSchema,
    repository: agentsRepositorySchema
      .nullable()
      .describe('Null when no definitions Repository is connected.'),
    agent: agentSummarySchema
      .extend({
        instructions: z
          .string()
          .describe('Plain text, never Markdown or HTML to render; empty for a built-in agent.'),
        files: z
          .array(z.object({ path: z.string(), size: z.number().int().min(0) }))
          .describe('Every file of the agent folder with its size in bytes; empty for a built-in.'),
      })
      .meta({ id: 'AgentDetailAgent' }),
    usedByWorkflows: z
      .array(z.string())
      .describe(
        'The workflows at the same commit whose sequence names this agent, valid or not, sorted by name.',
      ),
    usedByWorkflowsTruncated: z
      .boolean()
      .describe(
        'True when workflows beyond those read were not checked: the list may be incomplete.',
      ),
  })
  .meta({ id: 'AgentDetail' });

export class AgentDetailResponseDto extends createZodDto(agentDetailResponseSchema) {}
