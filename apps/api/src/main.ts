import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module.js';

const DEFAULT_PORT = 3001;

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(AppModule);
  // All HTTP routes live under /api so the web app can proxy them same-origin.
  app.setGlobalPrefix('api');
  await app.listen(process.env.PORT ?? DEFAULT_PORT);
}

await bootstrap();
