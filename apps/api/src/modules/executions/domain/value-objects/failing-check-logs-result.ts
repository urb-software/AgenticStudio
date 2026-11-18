import type { FailedCheckLog } from './failed-check-log.js';

export interface FailingCheckLogsResult {
  commit: string;
  checks: FailedCheckLog[];
}
