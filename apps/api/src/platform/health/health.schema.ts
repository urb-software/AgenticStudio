import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

/** Health response (200 only; 503 is a generic problem+json). */
export const healthResponseSchema = z
  .object({ status: z.literal('ok') })
  .meta({ id: 'HealthResponse' });

export class HealthResponseDto extends createZodDto(healthResponseSchema) {}
