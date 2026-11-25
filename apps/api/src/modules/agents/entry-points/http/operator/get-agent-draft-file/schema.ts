import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';
import { agentFilePathSchema } from '../../shared/agent-file-path.js';
import { agentFileResponseSchema } from '../../shared/agent-file-response.js';

export const getAgentDraftFileQuerySchema = z.strictObject({
  path: agentFilePathSchema.describe('Relative to the Repository root, with `/` separators.'),
});

export class GetAgentDraftFileQueryDto extends createZodDto(getAgentDraftFileQuerySchema) {}

export const AgentDraftFileResponseDto = createZodDto(agentFileResponseSchema);
