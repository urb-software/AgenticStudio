import type { DynamicModule, INestApplication, NestApplicationOptions, Type } from '@nestjs/common';
import { MAX_FILE_BYTES } from '@agentic-studio/agent-definitions';
import {
  PREVIEW_LOG_REQUEST_MAX_BYTES,
  RUN_DIFF_REQUEST_MAX_BYTES,
  WORKER_REQUEST_MAX_BYTES,
} from '@agentic-studio/contracts';
import { NestFactory } from '@nestjs/core';
import type { IncomingMessage } from 'node:http';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { AppModule } from './app.module.js';
import { verifyBearerToken } from './platform/auth/bearer-token.js';
import { SessionCookie } from './platform/auth/session-cookie.js';
import { APP_CONFIG, type AppConfig } from './platform/config/config.js';

/** Routes whose JSON bodies may exceed 100 KiB: worker step/state reports, Environment file. */
const LARGE_BODY_ROUTE =
  /^\/api\/(?:worker\/runs\/[^/]+\/(?:steps|state)|projects\/[^/]+\/environment-file)$/;
const RUN_DIFF_ROUTE = /^\/api\/worker\/runs\/[^/]+\/diff$/;
const PREVIEW_LOG_ROUTE = /^\/api\/controller\/operations\/[^/]+\/log$/;
/**
 * The Draft's save: a file of up to MAX_FILE_BYTES as text (JSON escaping can grow it) or as
 * base64 (a third larger). Two file limits hold both; a body over it is 413 and a text file whose
 * escaped form is longer is sent as base64.
 */
const AGENT_DRAFT_REQUEST_MAX_BYTES = 2 * MAX_FILE_BYTES;
const AGENT_DRAFT_ROUTE = /^\/api\/agents\/definitions-repository\/draft\/files$/;
/** A JSON save of a Draft file, from the Studio origin and with a session cookie (not yet checked). */
export function isDraftSave(
  request: IncomingMessage,
  config: Pick<AppConfig, 'studioOrigin'>,
  cookie: Pick<SessionCookie, 'read'>,
): boolean {
  const { origin } = request.headers;
  const sameOrigin =
    origin === undefined
      ? request.headers['sec-fetch-site'] === 'same-origin'
      : origin === config.studioOrigin;
  return (
    request.method === 'PUT' &&
    AGENT_DRAFT_ROUTE.test(request.url?.split('?')[0] ?? '') &&
    JSON_CONTENT_TYPE.test(request.headers['content-type'] ?? '') &&
    sameOrigin &&
    cookie.read(request) !== undefined
  );
}

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
  const { workerToken, controllerToken } = app.get<AppConfig>(APP_CONFIG);
  app.useBodyParser('json', {
    limit: RUN_DIFF_REQUEST_MAX_BYTES,
    type: (request: IncomingMessage) =>
      RUN_DIFF_ROUTE.test(request.url?.split('?')[0] ?? '') &&
      JSON_CONTENT_TYPE.test(request.headers['content-type'] ?? '') &&
      verifyBearerToken(workerToken, request.headers.authorization),
  });
  // A 64 KiB log batch of control characters escapes to six times its size; only the controller
  // token gets the larger limit.
  app.useBodyParser('json', {
    limit: PREVIEW_LOG_REQUEST_MAX_BYTES,
    type: (request: IncomingMessage) =>
      PREVIEW_LOG_ROUTE.test(request.url?.split('?')[0] ?? '') &&
      JSON_CONTENT_TYPE.test(request.headers['content-type'] ?? '') &&
      verifyBearerToken(controllerToken, request.headers.authorization),
  });
  // The guards run after the body is parsed, so the large Draft parser first checks what it can
  // without a lookup: the Studio origin and a session cookie. Anything else gets the 100 KiB one.
  const appConfig = app.get<AppConfig>(APP_CONFIG);
  const sessionCookie = new SessionCookie(appConfig);
  app.useBodyParser('json', {
    limit: AGENT_DRAFT_REQUEST_MAX_BYTES,
    type: (request: IncomingMessage) => isDraftSave(request, appConfig, sessionCookie),
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
