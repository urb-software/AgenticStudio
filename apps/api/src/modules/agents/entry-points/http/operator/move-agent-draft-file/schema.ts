import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';
import { agentFilePathSchema } from '../../shared/agent-file-path.js';

export const moveAgentDraftFileRequestSchema = z
  .strictObject({
    from: agentFilePathSchema.describe(
      'The file to move: a file of the Draft or of the base commit.',
    ),
    to: agentFilePathSchema.describe(
      'The new path; no file may be there unless the Draft deletes it.',
    ),
  })
  .meta({ id: 'MoveAgentDraftFileRequest' });

export class MoveAgentDraftFileRequestDto extends createZodDto(moveAgentDraftFileRequestSchema) {}
