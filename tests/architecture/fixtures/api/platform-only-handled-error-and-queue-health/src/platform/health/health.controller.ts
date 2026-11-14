import { HandledServerErrorException } from '../http/handled-server-error.js';
import { QueueHealth } from '../queue/queue-health.js';

// Allowed: the platform's own health endpoint uses both.
export class HealthController {
  constructor(private readonly queue: QueueHealth) {}

  async check(): Promise<string> {
    if (!(await this.queue.isAvailable())) throw new HandledServerErrorException();
    return 'ok';
  }
}
