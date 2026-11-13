import { HttpException } from '@nestjs/common';
import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

/** Media type of every API error response (RFC 9457). */
export const PROBLEM_JSON = 'application/problem+json';

const fieldErrorSchema = z.object({ path: z.string(), message: z.string() });

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
    errors: z.array(fieldErrorSchema).optional(),
  })
  .meta({ id: 'ProblemDetails' });

export type ProblemDetails = z.infer<typeof problemDetailsSchema>;

/** One field error of a problem details response. */
export type FieldError = z.infer<typeof fieldErrorSchema>;

export class ProblemDetailsDto extends createZodDto(problemDetailsSchema) {}

/**
 * A deliberate 4xx error about specific request fields (e.g. 409 for a name that is
 * already taken). The problem details carry its `errors[]` like a 400 validation error,
 * so the web app shows them next to the fields. A 5xx status stays generic regardless.
 */
export class FieldProblemException extends HttpException {
  constructor(
    status: number,
    detail: string,
    readonly errors: FieldError[],
  ) {
    super(detail, status);
  }
}

/**
 * A deliberate 5xx (e.g. the health endpoint's 503) whose cause its owner already logs.
 * The response stays generic like every 5xx, but the filter does not log it as an
 * unhandled error.
 */
export class HandledServerErrorException extends HttpException {
  constructor(status: number) {
    super('Handled server error', status);
  }
}
