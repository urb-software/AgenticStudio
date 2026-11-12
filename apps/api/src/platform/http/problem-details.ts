import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

/** Media type of every API error response (RFC 9457). */
export const PROBLEM_JSON = 'application/problem+json';

/**
 * The one error payload of the API (Epic #8, decision 1). `errors[].path` uses
 * dot notation (`tags.1`) so the web app can pass it to React Hook Form `setError`.
 */
export const problemDetailsSchema = z
  .object({
    type: z.string(),
    title: z.string(),
    status: z.number().int().min(400).max(599),
    detail: z.string(),
    correlationId: z.string(),
    errors: z.array(z.object({ path: z.string(), message: z.string() })).optional(),
  })
  .meta({ id: 'ProblemDetails' });

export type ProblemDetails = z.infer<typeof problemDetailsSchema>;

export class ProblemDetailsDto extends createZodDto(problemDetailsSchema) {}
