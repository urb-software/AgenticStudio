import { PROVIDERS, WORKFLOW_PROBLEM_CODES } from '@agentic-studio/agent-definitions';
import { z } from 'zod';
import { REPOSITORY_STATES } from '../../../../projects/contracts/index.js';
import type {
  WorkflowItemView,
  WorkflowView,
} from '../../../application/features/read-workflows/handler.js';
import type { WorkflowsRead } from '../../../application/workflows-reader.js';

const workflowProblemSchema = z
  .object({
    code: z.enum(WORKFLOW_PROBLEM_CODES as [string, ...string[]]),
    path: z
      .string()
      .describe('The file or folder the problem is about, relative to the Workflow folder.'),
    key: z
      .string()
      .nullable()
      .describe('The front matter key or item id, when the problem is about one; else null.'),
    message: z.string().describe('Fixed wording per code; never file content.'),
  })
  .meta({ id: 'WorkflowProblem' });

/** What the list shows of one Workflow, and the first part of the detail. */
export const workflowSummaryFields = {
  name: z
    .string()
    .describe('The name of the Workflow folder, as found; it may not be a valid name.'),
  description: z
    .string()
    .nullable()
    .describe('Null for a Workflow whose entry file does not judge.'),
  valid: z.boolean().describe('False while the folder, or an agent a phase names, has problems.'),
  usable: z
    .boolean()
    .describe('True when valid and every Provider its phases use is available now.'),
  notUsableReason: z
    .string()
    .nullable()
    .describe('Why a valid Workflow cannot be chosen now, naming the phase and the Provider.'),
  problems: z.array(workflowProblemSchema),
};

export const workflowsCommitSchema = z
  .string()
  .nullable()
  .describe(
    'The commit of the definitions Repository the Workflows were read at; null when none was.',
  );

export const workflowsRepositorySchema = z
  .object({
    state: z.enum(REPOSITORY_STATES),
    note: z
      .string()
      .nullable()
      .describe('Why the Workflows are the last known ones, or none; null when all is well.'),
  })
  .meta({ id: 'WorkflowsRepository' });

const phaseFields = {
  id: z.string().describe('The phase id, unique within the Workflow.'),
  agent: z.string().describe('The name of the agent that does the phase, as written.'),
  agentState: z
    .enum(['valid', 'invalid', 'missing'])
    .describe('Whether the agent exists at the same commit and is valid.'),
  provider: z
    .enum(PROVIDERS)
    .nullable()
    .describe('The Provider of the agent; null while the agent is not valid.'),
  usable: z.boolean().describe('True when the agent is valid and its Provider is available now.'),
};

export const workflowItemSchema = z
  .discriminatedUnion('kind', [
    z.object({ kind: z.literal('work'), ...phaseFields }).meta({ id: 'WorkflowWorkPhase' }),
    z.object({ kind: z.literal('review'), ...phaseFields }).meta({ id: 'WorkflowReviewPhase' }),
    z
      .object({
        kind: z.literal('checkpoint'),
        id: z.string(),
        text: z.string().describe('Plain text for the operator; it may hold line breaks.'),
      })
      .meta({ id: 'WorkflowCheckpoint' }),
  ])
  .meta({ id: 'WorkflowItem' });

export function toWorkflowSummary(workflow: WorkflowView) {
  return {
    name: workflow.name,
    description: workflow.description,
    valid: workflow.valid,
    usable: workflow.usable,
    notUsableReason: workflow.notUsableReason,
    problems: workflow.problems.map((problem) => ({
      code: problem.code,
      path: problem.path,
      key: problem.key ?? null,
      message: problem.message,
    })),
  };
}

export function toWorkflowItem(item: WorkflowItemView) {
  return item.kind === 'checkpoint'
    ? { kind: item.kind, id: item.id, text: item.text }
    : {
        kind: item.kind,
        id: item.id,
        agent: item.agent,
        agentState: item.agentState,
        provider: item.provider,
        usable: item.usable,
      };
}

export function toWorkflowsRepository(repository: WorkflowsRead['repository']) {
  return repository ? { state: repository.state, note: repository.note } : null;
}
