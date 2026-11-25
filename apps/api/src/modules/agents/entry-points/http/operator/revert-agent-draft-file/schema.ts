import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';
import { agentFilePathSchema } from '../../shared/agent-file-path.js';

export const revertAgentDraftFileRequestSchema = z
  .strictObject({
    path: agentFilePathSchema.describe('Relative to the Repository root, with `/` separators.'),
  })
  .meta({ id: 'RevertAgentDraftFileRequest' });

export class RevertAgentDraftFileRequestDto extends createZodDto(
  revertAgentDraftFileRequestSchema,
) {}
