import { STATUS_CODES } from 'node:http';
import { applyDecorators, HttpException, HttpStatus } from '@nestjs/common';
import { ApiResponse, getSchemaPath } from '@nestjs/swagger';
import { createZodDto } from 'nestjs-zod';
import { z, ZodError } from 'zod';

/** Media type of every API error response (RFC 9457). */
export const PROBLEM_JSON = 'application/problem+json';

/** The `detail` of every generic 5xx response. */
export const GENERIC_SERVER_DETAIL = 'An unexpected error occurred.';

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
 * A deliberate error whose `type`, `title`, `detail` and optional field errors are written for
 * the client, at any status. Unlike other 5xx responses, a 5xx `ProblemException` (e.g. 501
 * "Unsupported platform") keeps its text and is not logged as an unhandled error, so it must
 * never carry internals: only fixed, operator-facing text.
 */
export class ProblemException extends HttpException {
  constructor(
    status: number,
    readonly problem: { type: string; title: string; detail: string; errors?: FieldError[] },
  ) {
    super(problem.detail, status);
  }
}

/**
 * The plain form of a {@link ProblemException} (#72): a deliberate 4xx error about specific
 * request fields (e.g. 409 for a name that is already taken), with no problem type of its own
 * (`about:blank`, the status text as title). The problem details carry its `errors[]` like a
 * 400 validation error, so the web app shows them next to the fields. 4xx only: a 5xx would
 * keep its text, so it is refused as a programming error (and then answered as a generic 500).
 */
export class FieldProblemException extends ProblemException {
  constructor(status: number, detail: string, errors: FieldError[]) {
    if (status < 400 || status >= 500) {
      throw new RangeError(`A field problem is a 4xx error, not ${status}.`);
    }
    super(status, { type: 'about:blank', title: STATUS_CODES[status] ?? 'Error', detail, errors });
  }
}

/**
 * A deliberate 503 whose cause its owner already logs (e.g. the job queue is down). The body
 * is exactly the generic 5xx body, and it is not logged as an unhandled error.
 */
export function serviceUnavailable(): ProblemException {
  return new ProblemException(HttpStatus.SERVICE_UNAVAILABLE, {
    type: 'about:blank',
    title: STATUS_CODES[HttpStatus.SERVICE_UNAVAILABLE]!,
    detail: GENERIC_SERVER_DETAIL,
  });
}

/** The field errors of a Zod validation error, with dot-notation paths. */
export function zodFieldErrors(error: unknown): FieldError[] {
  const issues = error instanceof ZodError ? error.issues : [];
  return issues.map((issue) => ({
    path: issue.path.map(String).join('.'),
    message: issue.message,
  }));
}

/**
 * Documents an endpoint's deliberate error statuses as problem+json responses in OpenAPI
 * (every other status stays under the global `default` response).
 */
export function ApiProblemResponses(responses: Record<number, string>) {
  return applyDecorators(
    ...Object.entries(responses).map(([status, description]) =>
      ApiResponse({
        status: Number(status),
        description,
        content: { [PROBLEM_JSON]: { schema: { $ref: getSchemaPath(ProblemDetailsDto) } } },
      }),
    ),
  );
}
