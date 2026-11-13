import type { DynamicModule, INestApplication, NestApplicationOptions, Type } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { AppModule } from './app.module.js';
import { APP_CONFIG, type AppConfig } from './platform/config/config.js';

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
  app.useBodyParser('json');
  app.disable('x-powered-by');
  // `request.ip` honours X-Forwarded-For only from the configured trusted proxies
  // (right-most untrusted hop); with none, it is the socket address.
  const { apiTrustedProxies } = app.get<AppConfig>(APP_CONFIG);
  app.set('trust proxy', apiTrustedProxies.length > 0 ? apiTrustedProxies : false);
  // All HTTP routes live under /api so the web app can proxy them same-origin.
  app.setGlobalPrefix('api');
  return app;
}
