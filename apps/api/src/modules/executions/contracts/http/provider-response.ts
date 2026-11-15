import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';
import { runProviderSchema } from './run-response.js';

/**
 * A provider as the operator API offers it (Issue #101): whether a Run can be started with it
 * now and, when not, why ("Switched off on the agent worker", "No agent worker is connected").
 */
export const providerAvailabilitySchema = z
  .object({
    id: runProviderSchema,
    name: z.string(),
    available: z.boolean(),
    reason: z.string().optional(),
  })
  .meta({ id: 'ProviderAvailability' });

export const providerListResponseSchema = z
  .array(providerAvailabilitySchema)
  .meta({ id: 'ProviderList' });

export class ProviderListResponseDto extends createZodDto(providerListResponseSchema) {}
