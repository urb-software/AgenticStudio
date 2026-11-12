import { randomUUID } from 'node:crypto';
import { STATUS_CODES } from 'node:http';
import {
  type ArgumentsHost,
  Catch,
  type ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import { HttpAdapterHost } from '@nestjs/core';
import { ZodValidationException } from 'nestjs-zod';
import { ZodError } from 'zod';
import { FieldProblemException, PROBLEM_JSON, type ProblemDetails } from './problem-details.js';
import { redactSecrets } from './redact.js';

const GENERIC_SERVER_DETAIL = 'An unexpected error occurred.';

/**
 * Maps every error to RFC 9457 problem+json. Only 4xx details reach the client;
 * 5xx responses are generic and the cause is logged server-side under the
 * correlation id, so stacks, paths, configuration and database errors never leak.
 */
@Catch()
export class ProblemDetailsFilter implements ExceptionFilter {
  private readonly logger = new Logger('HTTP');

  constructor(private readonly adapterHost: HttpAdapterHost) {}

  catch(exception: unknown, host: ArgumentsHost): void {
    const { httpAdapter } = this.adapterHost;
    const response: unknown = host.switchToHttp().getResponse();
    const correlationId = randomUUID();
    const problem = this.toProblem(exception, correlationId);

    if (problem.status >= 500) {
      const cause =
        exception instanceof Error ? (exception.stack ?? exception.message) : String(exception);
      this.logger.error(`Unhandled error [correlationId=${correlationId}]`, redactSecrets(cause));
    }

    httpAdapter.setHeader(response, 'Content-Type', PROBLEM_JSON);
    httpAdapter.reply(response, JSON.stringify(problem), problem.status);
  }

  private toProblem(exception: unknown, correlationId: string): ProblemDetails {
    const status = statusOf(exception);
    const base = {
      type: 'about:blank',
      title: STATUS_CODES[status] ?? 'Error',
      status,
      correlationId,
    };

    if (status >= 500) {
      return { ...base, detail: GENERIC_SERVER_DETAIL };
    }
    if (exception instanceof ZodValidationException) {
      const error = exception.getZodError();
      const issues = error instanceof ZodError ? error.issues : [];
      return {
        ...base,
        detail: 'The request is invalid.',
        errors: issues.map((issue) => ({
          path: issue.path.map(String).join('.'),
          message: issue.message,
        })),
      };
    }
    if (exception instanceof FieldProblemException) {
      return { ...base, detail: exception.message, errors: exception.errors };
    }
    // Nest turns malformed JSON (SyntaxError) and bad URI encoding (URIError) into a
    // 400 that carries the parser's message; keep the status, not the internals.
    if (exception instanceof HttpException && !isParserError(exception.cause)) {
      return { ...base, detail: exception.message };
    }
    return { ...base, detail: 'The request could not be processed.' };
  }
}

function isParserError(cause: unknown): boolean {
  return cause instanceof SyntaxError || cause instanceof URIError;
}

function statusOf(exception: unknown): number {
  return exception instanceof HttpException
    ? exception.getStatus()
    : HttpStatus.INTERNAL_SERVER_ERROR;
}
