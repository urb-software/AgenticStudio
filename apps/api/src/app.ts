import type { DynamicModule, INestApplication, NestApplicationOptions, Type } from '@nestjs/common';
import { WORKER_REQUEST_MAX_BYTES } from '@agentic-studio/contracts';
import { NestFactory } from '@nestjs/core';
import type { IncomingMessage } from 'node:http';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { AppModule } from './app.module.js';
import { APP_CONFIG, type AppConfig } from './platform/config/config.js';

/**
 * The routes whose bodies may exceed 100 KiB: a Run's step and state reports (worker), and
 * setting a project's Environment file (operator, Issue #104: 64 KiB of content can grow in
 * JSON, e.g. every quote and line break escaped).
 */
const LARGE_BODY_ROUTE =
  /^\/api\/(?:worker\/runs\/[^/]+\/(?:steps|state)|projects\/[^/]+\/environment-file)$/;
/** What the JSON body parser treats as JSON (`application/json` and `+json` types). */
const JSON_CONTENT_TYPE = /^application\/(?:[\w.+-]+\+)?json\s*(?:;|$)/i;

/** Builds the HTTP application exactly as production runs it; tests use it too. */
export async function createApp(
  config: AppConfig,
  options: Parameters<typeof AppModule.register>[1] = {},
): Promise<INestApplication> {
  return buildApp(AppModule.register(config, options));
}

/**
 * Applies the production HTTP set-up to any root module that imports {@link AppModule}.
 * Tests use it to add test-only controllers without registering them in production.
 */
export async function buildApp(
  rootModule: Type | DynamicModule,
  options: NestApplicationOptions = {},
): Promise<INestApplication> {
  const app = await NestFactory.create<NestExpressApplication>(rootModule, {
    abortOnError: false,
    // JSON is the only request body the API accepts (mutations must be JSON).
    bodyParser: false,
    ...options,
  });
  // The worker's step and state reports (Issue #98): up to 192 KiB (WORKER_REQUEST_MAX_BYTES),
  // since the protocol caps a Run step's result (RUN_STEP_RESULT_MAX_BYTES) and a Working copy
  // report (WORKING_COPY_REPORT_MAX_BYTES) so such a report always fits; an Environment file
  // (Issue #104) the same. Parsed first; the general parser then skips a body that is already
  // parsed.
  app.useBodyParser('json', {
    limit: WORKER_REQUEST_MAX_BYTES,
    type: (request: IncomingMessage) =>
      LARGE_BODY_ROUTE.test(request.url?.split('?')[0] ?? '') &&
      JSON_CONTENT_TYPE.test(request.headers['content-type'] ?? ''),
  });
  // Every other route: 100 KiB, Express's default, made explicit.
  app.useBodyParser('json', { limit: '100kb' });
  app.disable('x-powered-by');
  // `request.ip` honours X-Forwarded-For only from the configured trusted proxies
  // (right-most untrusted hop); with none, it is the socket address.
  const { apiTrustedProxies } = app.get<AppConfig>(APP_CONFIG);
  app.set('trust proxy', apiTrustedProxies.length > 0 ? apiTrustedProxies : false);
  // All HTTP routes live under /api so the web app can proxy them same-origin.
  app.setGlobalPrefix('api');
  return app;
}
