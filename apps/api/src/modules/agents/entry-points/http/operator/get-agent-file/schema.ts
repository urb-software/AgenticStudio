import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';
import { agentFilePathSchema } from '../../shared/agent-file-path.js';
import { agentFileResponseSchema } from '../../shared/agent-file-response.js';

export const getAgentFileQuerySchema = z.strictObject({
  path: agentFilePathSchema.describe('Relative to the Repository root, with `/` separators.'),
  commit: z
    .string()
    .regex(/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/, 'Use a full commit id in lower-case hex.')
    .optional()
    .describe('A full commit id the Clone holds; the last fetched commit when omitted.'),
});

export class GetAgentFileQueryDto extends createZodDto(getAgentFileQuerySchema) {}

export { agentFileResponseSchema };

export const AgentFileResponseDto = createZodDto(agentFileResponseSchema);
