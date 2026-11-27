import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';
import {
  workflowsCommitSchema,
  workflowsRepositorySchema,
  workflowSummaryFields,
} from '../../shared/workflow-response.js';

export const workflowListResponseSchema = z
  .object({
    commit: workflowsCommitSchema,
    repository: workflowsRepositorySchema
      .nullable()
      .describe('Null when no definitions Repository is connected.'),
    truncated: z.boolean().describe('True when more Workflow folders exist than are listed.'),
    workflows: z.array(z.object(workflowSummaryFields).meta({ id: 'WorkflowSummary' })),
  })
  .meta({ id: 'WorkflowList' });

export class WorkflowListResponseDto extends createZodDto(workflowListResponseSchema) {}
