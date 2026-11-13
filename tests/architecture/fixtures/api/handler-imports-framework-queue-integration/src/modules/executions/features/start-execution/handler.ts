import { InjectQueue } from '@nestjs/bullmq';

export class StartExecutionHandler {
  constructor(@InjectQueue('executions') private readonly queue: { add(name: string): unknown }) {}

  async execute(): Promise<void> {
    await this.queue.add('start');
  }
}
