import type { DynamicModule, INestApplication, NestApplicationOptions, Type } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module.js';
import type { AppConfig } from './platform/config/config.js';

/** Builds the HTTP application exactly as production runs it; tests use it too. */
export async function createApp(config: AppConfig): Promise<INestApplication> {
  return buildApp(AppModule.register(config));
}

/**
 * Applies the production HTTP set-up to any root module that imports {@link AppModule}.
 * Tests use it to add test-only controllers without registering them in production.
 */
export async function buildApp(
  rootModule: Type | DynamicModule,
  options: NestApplicationOptions = {},
): Promise<INestApplication> {
  const app = await NestFactory.create(rootModule, { abortOnError: false, ...options });
  // All HTTP routes live under /api so the web app can proxy them same-origin.
  app.setGlobalPrefix('api');
  return app;
}
