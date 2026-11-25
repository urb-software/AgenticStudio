import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';
import { agentFilePathSchema } from '../../shared/agent-file-path.js';

export const deleteAgentDraftFileQuerySchema = z.strictObject({
  path: agentFilePathSchema.describe('Relative to the Repository root, with `/` separators.'),
});

export class DeleteAgentDraftFileQueryDto extends createZodDto(deleteAgentDraftFileQuerySchema) {}
