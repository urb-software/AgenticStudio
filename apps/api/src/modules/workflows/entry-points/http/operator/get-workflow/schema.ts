import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';
import {
  workflowItemSchema,
  workflowsCommitSchema,
  workflowsRepositorySchema,
  workflowSummaryFields,
} from '../../shared/workflow-response.js';

export const workflowDetailResponseSchema = z
  .object({
    commit: workflowsCommitSchema,
    repository: workflowsRepositorySchema
      .nullable()
      .describe('Null when no definitions Repository is connected.'),
    ...workflowSummaryFields,
    sendBacks: z
      .number()
      .int()
      .min(0)
      .nullable()
      .describe(
        'The most times work goes back to a work phase in one Run, the default applied; null ' +
          'for a Workflow whose sequence does not judge.',
      ),
    items: z
      .array(workflowItemSchema)
      .describe('The phases and checkpoints in order; empty for a Workflow that does not judge.'),
  })
  .meta({ id: 'WorkflowDetail' });

export class WorkflowDetailResponseDto extends createZodDto(workflowDetailResponseSchema) {}
