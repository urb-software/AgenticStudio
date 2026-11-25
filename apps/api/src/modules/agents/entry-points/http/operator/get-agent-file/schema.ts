import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';
import { agentFilePathSchema } from '../../shared/agent-file-path.js';

export const getAgentFileQuerySchema = z.strictObject({
  path: agentFilePathSchema.describe('Relative to the Repository root, with `/` separators.'),
  commit: z
    .string()
    .regex(/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/, 'Use a full commit id in lower-case hex.')
    .optional()
    .describe('A full commit id the Clone holds; the last fetched commit when omitted.'),
});

export class GetAgentFileQueryDto extends createZodDto(getAgentFileQuerySchema) {}

const fileAt = {
  commit: z.string().describe('The commit the file was read at.'),
  path: z.string(),
};

/** `text` has `content`; `binary` (a NUL byte, or not valid UTF-8) and `too_large` (over 1 MiB) have only `size`. */
export const agentFileResponseSchema = z
  .discriminatedUnion('kind', [
    z
      .strictObject({
        ...fileAt,
        kind: z.literal('text'),
        content: z.string().describe('Plain text, never to be rendered as HTML or followed.'),
      })
      .meta({ id: 'AgentFileText' }),
    z
      .strictObject({ ...fileAt, kind: z.literal('binary'), size: z.number().int().min(0) })
      .meta({ id: 'AgentFileBinary' }),
    z
      .strictObject({ ...fileAt, kind: z.literal('too_large'), size: z.number().int().min(0) })
      .meta({ id: 'AgentFileTooLarge' }),
  ])
  .meta({ id: 'AgentFile' });

export const AgentFileResponseDto = createZodDto(agentFileResponseSchema);
