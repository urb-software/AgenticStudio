import { closePullRequestResponseSchema } from '@agentic-studio/contracts';
import { createZodDto } from 'nestjs-zod';

export class ClosePullRequestResponseDto extends createZodDto(
  closePullRequestResponseSchema.meta({ id: 'ClosePullRequestResponse' }),
) {}
