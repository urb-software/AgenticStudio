import { Module } from '@nestjs/common';
import { queueHealthProvider } from '../queue/queue.module.js';
import { HealthController } from './health.controller.js';

/** The public health endpoint. */
@Module({
  controllers: [HealthController],
  providers: [queueHealthProvider],
})
export class HealthModule {}
