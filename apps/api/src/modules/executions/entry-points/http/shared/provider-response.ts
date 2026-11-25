import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';
import { runProviderSchema } from './run-response.js';

export const providerAvailabilitySchema = z
  .object({
    id: runProviderSchema,
    name: z.string(),
    available: z.boolean(),
    reason: z.string().optional(),
    models: z
      .array(z.string())
      .describe('The models an agent may name for this provider; `default` is the CLI own.'),
  })
  .meta({ id: 'ProviderAvailability' });

export const providerListResponseSchema = z
  .array(providerAvailabilitySchema)
  .meta({ id: 'ProviderList' });

export class ProviderListResponseDto extends createZodDto(providerListResponseSchema) {}
