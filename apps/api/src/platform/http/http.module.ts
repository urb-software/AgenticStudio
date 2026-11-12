import { Module } from '@nestjs/common';
import { APP_FILTER, APP_INTERCEPTOR, APP_PIPE } from '@nestjs/core';
import { ZodSerializerInterceptor, ZodValidationPipe } from 'nestjs-zod';
import { ProblemDetailsFilter } from './problem-details.filter.js';

/**
 * App-wide HTTP behavior: Zod DTOs validate every request (400 on failure),
 * `@ZodResponse` schemas validate and strip every response, and every error
 * becomes problem+json.
 */
@Module({
  providers: [
    { provide: APP_PIPE, useClass: ZodValidationPipe },
    { provide: APP_INTERCEPTOR, useClass: ZodSerializerInterceptor },
    { provide: APP_FILTER, useClass: ProblemDetailsFilter },
  ],
})
export class HttpModule {}
