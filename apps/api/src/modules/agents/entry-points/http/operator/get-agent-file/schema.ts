import {
  ENVIRONMENT_FILE_PATH_MAX_LENGTH,
  environmentFilePathProblem,
} from '@agentic-studio/contracts';
import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

export const getAgentFileQuerySchema = z.strictObject({
  path: z
    .string()
    .min(1)
    .max(ENVIRONMENT_FILE_PATH_MAX_LENGTH)
    .superRefine((path, context) => {
      const problem = environmentFilePathProblem(path);
      if (problem !== null) context.addIssue({ code: 'custom', message: problem });
    })
    .describe('Relative to the Repository root, with `/` separators.'),
  commit: z
    .string()
    .regex(/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/, 'Use a full commit id in lower-case hex.')
    .optional()
    .describe('A full commit id the Clone holds; the last fetched commit when omitted.'),
});

export class GetAgentFileQueryDto extends createZodDto(getAgentFileQuerySchema) {}

export const agentFileResponseSchema = z
  .object({
    commit: z.string().describe('The commit the file was read at.'),
    path: z.string(),
    kind: z
      .enum(['text', 'binary', 'too_large'])
      .describe(
        '`text` has `content`; `binary` (a NUL byte, or not valid UTF-8) and `too_large` (over ' +
          'the 1 MiB file limit) have only `size`.',
      ),
    content: z
      .string()
      .optional()
      .describe('Only for `text`. Plain text, never to be rendered as HTML or followed.'),
    size: z.number().int().min(0).optional().describe('Bytes; only for `binary` and `too_large`.'),
  })
  .meta({ id: 'AgentFile' });

export class AgentFileResponseDto extends createZodDto(agentFileResponseSchema) {}
