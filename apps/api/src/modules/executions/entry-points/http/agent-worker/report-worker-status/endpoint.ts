import { Body, HttpCode, HttpStatus, Post } from '@nestjs/common';
import { WorkerController } from '../../../../../../platform/auth/worker-route.js';
import { ReportWorkerStatusHandler } from '../../../../application/features/report-worker-status/handler.js';
import { WorkerStatusRequestDto } from './schema.js';

@WorkerController('status')
export class ReportWorkerStatusEndpoint {
  constructor(private readonly handler: ReportWorkerStatusHandler) {}

  @Post()
  @HttpCode(HttpStatus.NO_CONTENT)
  async report(@Body() body: WorkerStatusRequestDto): Promise<void> {
    await this.handler.execute(body);
  }
}
