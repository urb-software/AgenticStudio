import { randomUUID } from 'node:crypto';
import { assertSupportedPlatform, loadWorkerConfig, type WorkerConfig } from './config.js';
import { FakeRunner } from './fake-runner.js';
import { StudioApi } from './studio-api.js';
import { AgentWorker, type WorkerLogger } from './worker.js';

// The agent worker process (Issue #96). It runs on the host as the agent user and only calls
// the Studio API with the worker token; it has no database, Redis or secret-store access.
// Fail fast: a wrong platform or an invalid environment stops it before it polls.
try {
  assertSupportedPlatform(process.platform);
} catch (error) {
  console.error((error as Error).message);
  process.exit(1);
}
let config: WorkerConfig;
try {
  config = loadWorkerConfig(process.env);
} catch (error) {
  // Names variables, never their values.
  console.error((error as Error).message);
  process.exit(1);
}

const workerId = randomUUID();
const logger: WorkerLogger = {
  info: (message) => console.log(`[agent-worker ${workerId}] ${message}`),
  error: (message) => console.error(`[agent-worker ${workerId}] ${message}`),
};
const worker = new AgentWorker({
  api: new StudioApi({
    apiUrl: config.apiUrl,
    token: config.token,
    workerId,
    timeoutMs: config.requestTimeoutMs,
  }),
  // Every Run uses the fake runner until the provider adapters exist (#96 decision).
  runner: new FakeRunner(),
  pollMs: config.pollMs,
  heartbeatMs: config.heartbeatMs,
  logger,
});

let shuttingDown = false;
const shutDown = (signal: string) => {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info(`${signal} received: stopping.`);
  void worker.stop().then(() => process.exit(0));
};
process.on('SIGTERM', () => shutDown('SIGTERM'));
process.on('SIGINT', () => shutDown('SIGINT'));

logger.info(`Polling ${config.apiUrl} every ${config.pollMs} ms.`);
await worker.run();
