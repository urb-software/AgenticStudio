import { Module } from '@nestjs/common';
import { HealthController } from './platform/health/health.controller.js';

@Module({
  controllers: [HealthController],
})
export class AppModule {}
