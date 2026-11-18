import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

export const refreshPullRequestRequestSchema = z
  .strictObject({ onOpen: z.boolean().optional() })
  .meta({ id: 'RefreshPullRequestRequest' });

export class RefreshPullRequestRequestDto extends createZodDto(refreshPullRequestRequestSchema) {}
