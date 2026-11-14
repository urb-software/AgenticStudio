export abstract class JobQueues {
  abstract register(name: string): void;
}

// Forbidden: the platform-only health view re-exported through the port modules use.
export { queueHealthProvider } from './queue-health.provider.js';
