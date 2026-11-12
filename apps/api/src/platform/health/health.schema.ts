import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

/** Liveness response. The `id` names the schema in OpenAPI and the generated client. */
export const healthResponseSchema = z
  .object({ status: z.literal('ok') })
  .meta({ id: 'HealthResponse' });

export class HealthResponseDto extends createZodDto(healthResponseSchema) {}
