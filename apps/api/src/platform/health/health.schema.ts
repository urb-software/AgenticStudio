import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

/** Health response (200 only; 503 is a generic problem+json). The `id` names the schema in OpenAPI and the generated client. */
export const healthResponseSchema = z
  .object({ status: z.literal('ok') })
  .meta({ id: 'HealthResponse' });

export class HealthResponseDto extends createZodDto(healthResponseSchema) {}
