import type { Provider } from './provider.js';
import type { WorkerDiskFigures } from './worker-disk-figures.js';
import type { WorkerRunnerMode } from './worker-runner-mode.js';

/** Studio keeps it in memory only. */
export interface RecordedWorkerStatus {
  workerId: string;
  runner: WorkerRunnerMode;
  providers: Record<Provider, boolean>;
  providerReasons?: Partial<Record<Provider, string>>;
  disk?: WorkerDiskFigures;
  reportedAt: Date;
}
