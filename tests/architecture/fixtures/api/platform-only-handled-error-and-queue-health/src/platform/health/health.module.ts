import { queueHealthProvider } from '../queue/queue-health.provider.js';
import { HealthController } from './health.controller.js';

export const healthModule = { controllers: [HealthController], providers: [queueHealthProvider] };
