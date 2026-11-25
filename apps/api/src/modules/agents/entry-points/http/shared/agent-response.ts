import { PROBLEM_CODES, PROVIDERS } from '@agentic-studio/agent-definitions';
import { z } from 'zod';
import { REPOSITORY_STATES } from '../../../../projects/contracts/index.js';
import type {
  AgentView,
  ReadAgentsResult,
} from '../../../application/features/read-agents/handler.js';

const problemSchema = z
  .object({
    code: z.enum(PROBLEM_CODES),
    path: z
      .string()
      .describe('The file or folder the problem is about, relative to the agent folder.'),
    key: z.string().nullable().describe('The front matter key, when the problem is about one.'),
    message: z.string().describe('Fixed wording per code; never a value or file content.'),
  })
  .meta({ id: 'AgentProblem' });

/** What the list shows of one agent, and the first part of the detail. */
export const agentSummarySchema = z
  .object({
    name: z.string(),
    description: z.string().nullable().describe('Null for an agent that is not usable.'),
    provider: z.enum(PROVIDERS).nullable().describe('Null for an agent that is not usable.'),
    model: z.string().nullable().describe('Null for an agent that is not usable.'),
    source: z
      .enum(['built_in', 'definitions'])
      .describe('A built-in Default agent, or a folder of the definitions Repository.'),
    usable: z.boolean().describe('False while the definition has problems.'),
    problems: z.array(problemSchema),
  })
  .meta({ id: 'AgentSummary' });

/** The definitions Repository's state and, when it is not ready or not readable, why that matters. */
export const agentsRepositorySchema = z
  .object({
    state: z.enum(REPOSITORY_STATES),
    note: z
      .string()
      .nullable()
      .describe('Why the agents are the last known ones, or none; null when all is well.'),
  })
  .meta({ id: 'AgentsRepository' });

export const agentsCommitSchema = z
  .string()
  .nullable()
  .describe(
    'The commit of the definitions Repository the agents were read at; null when none was.',
  );

export function toAgentSummary(agent: AgentView) {
  return {
    name: agent.name,
    description: agent.description,
    provider: agent.provider,
    model: agent.model,
    source: agent.source,
    usable: agent.usable,
    problems: agent.problems.map((problem) => ({
      code: problem.code,
      path: problem.path,
      key: problem.key ?? null,
      message: problem.message,
    })),
  };
}

export function toAgentsRepository(repository: ReadAgentsResult['repository']) {
  return repository ? { state: repository.state, note: repository.note } : null;
}
