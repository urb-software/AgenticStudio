import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';
import { PublishMessage } from '../../../../domain/value-objects/publish-message.js';

export const publishAgentDraftRequestSchema = z
  .strictObject({
    message: z
      .string()
      .min(1)
      .max(PublishMessage.MAX_LENGTH)
      .refine((message) => !message.includes('\0'), 'The message must not contain a NUL character.')
      .describe(
        'The commit message, 1 to 2,000 characters; the first line is the subject. Author and ' +
          'committer are never taken from the request.',
      ),
    baseCommit: z
      .string()
      .regex(/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/)
      .describe("The Draft's base commit, as the page showed it."),
    version: z
      .number()
      .int()
      .min(0)
      .describe("The Draft's `version`, as the page showed it; another version is a conflict."),
  })
  .meta({ id: 'PublishAgentDraftRequest' });

export class PublishAgentDraftRequestDto extends createZodDto(publishAgentDraftRequestSchema) {}

export const publishAgentDraftResponseSchema = z
  .object({
    commit: z.string().describe('The commit now on the Integration branch of the Repository.'),
  })
  .meta({ id: 'PublishAgentDraftResult' });

export class PublishAgentDraftResponseDto extends createZodDto(publishAgentDraftResponseSchema) {}
