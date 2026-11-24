import type { DynamicModule, INestApplication, NestApplicationOptions, Type } from '@nestjs/common';
import { RUN_DIFF_REQUEST_MAX_BYTES, WORKER_REQUEST_MAX_BYTES } from '@agentic-studio/contracts';
import { NestFactory } from '@nestjs/core';
import type { IncomingMessage } from 'node:http';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { AppModule } from './app.module.js';
import { verifyBearerToken } from './platform/auth/bearer-token.js';
import { APP_CONFIG, type AppConfig } from './platform/config/config.js';

/** Routes whose JSON bodies may exceed 100 KiB: worker step/state reports, Environment file. */
const LARGE_BODY_ROUTE =
  /^\/api\/(?:worker\/runs\/[^/]+\/(?:steps|state)|projects\/[^/]+\/environment-file)$/;
const RUN_DIFF_ROUTE = /^\/api\/worker\/runs\/[^/]+\/diff$/;
const JSON_CONTENT_TYPE = /^application\/(?:[\w.+-]+\+)?json\s*(?:;|$)/i;

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
  // Sized to the protocol caps so a worker report always fits; an Environment file's JSON
  // escaping can outgrow its 64 KiB. Parsed first: the general parser skips a parsed body.
  app.useBodyParser('json', {
    limit: WORKER_REQUEST_MAX_BYTES,
    type: (request: IncomingMessage) =>
      LARGE_BODY_ROUTE.test(request.url?.split('?')[0] ?? '') &&
      JSON_CONTENT_TYPE.test(request.headers['content-type'] ?? ''),
  });
  // Two diffs of up to RUN_DIFF_MAX_BYTES each; the larger limit needs the worker token, any
  // other request there gets the 100 KiB parser below.
  const { workerToken } = app.get<AppConfig>(APP_CONFIG);
  app.useBodyParser('json', {
    limit: RUN_DIFF_REQUEST_MAX_BYTES,
    type: (request: IncomingMessage) =>
      RUN_DIFF_ROUTE.test(request.url?.split('?')[0] ?? '') &&
      JSON_CONTENT_TYPE.test(request.headers['content-type'] ?? '') &&
      verifyBearerToken(workerToken, request.headers.authorization),
  });
  app.useBodyParser('json', { limit: '100kb' });
  app.disable('x-powered-by');
  // `request.ip` honours X-Forwarded-For only from the configured trusted proxies
  // (right-most untrusted hop); with none, it is the socket address.
  const { apiTrustedProxies } = app.get<AppConfig>(APP_CONFIG);
  app.set('trust proxy', apiTrustedProxies.length > 0 ? apiTrustedProxies : false);
  app.setGlobalPrefix('api');
  return app;
}
