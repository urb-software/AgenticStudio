import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';
import { agentFilePathSchema } from '../../shared/agent-file-path.js';

const BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

export const saveAgentDraftFileRequestSchema = z
  .strictObject({
    path: agentFilePathSchema.describe('Relative to the Repository root, with `/` separators.'),
    text: z
      .string()
      .optional()
      .describe('The content, stored as UTF-8. Give this or `contentBase64`.'),
    contentBase64: z
      .string()
      .regex(BASE64, 'Use standard base64 with padding.')
      .optional()
      .describe('The content as standard base64, for a binary file. Give this or `text`.'),
  })
  .refine((body) => (body.text === undefined) !== (body.contentBase64 === undefined), {
    message: 'Give exactly one of `text` and `contentBase64`.',
    path: ['text'],
  })
  .meta({ id: 'SaveAgentDraftFileRequest' });

export class SaveAgentDraftFileRequestDto extends createZodDto(saveAgentDraftFileRequestSchema) {}
