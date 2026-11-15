import { randomUUID } from 'node:crypto';
import { assertSupportedPlatform, loadWorkerConfig, type WorkerConfig } from './config.js';
import { FakeRunner } from './fake-runner.js';
import { GitRunner } from './git.js';
import { RETENTION_INTERVAL_MS, Retention } from './retention.js';
import { DockerRunResources } from './run-resources.js';
import { StudioApi } from './studio-api.js';
import { AgentWorker, type WorkerLogger } from './worker.js';
import { WorkingCopies } from './working-copy.js';

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
const api = new StudioApi({
  apiUrl: config.apiUrl,
  token: config.token,
  workerId,
  timeoutMs: config.requestTimeoutMs,
});
// The agent user's own environment and Git configuration (its Git credentials live there).
const git = new GitRunner();
const worker = new AgentWorker({
  api,
  // Every Run uses the fake runner until the provider adapters exist (#96 decision).
  runner: new FakeRunner({ git }),
  workingCopies: new WorkingCopies({
    dataDir: config.dataDir,
    git,
    agentGitName: config.agentGitName,
    agentGitEmail: config.agentGitEmail,
    // Local (file) remotes only for a development or test worker (coordinator decision, #98).
    allowFileRemotes: config.environment !== 'production',
    logger,
  }),
  pollMs: config.pollMs,
  heartbeatMs: config.heartbeatMs,
  logger,
});

// Working copy retention (Issue #98): at start (which also removes leftover directories
// without a known Run) and hourly; a failed pass is logged and retried at the next one.
const retention = new Retention({
  dataDir: config.dataDir,
  runStates: (runIds, signal) => api.runStates(runIds, signal),
  resources: new DockerRunResources(undefined, logger),
  retentionDays: config.retentionDays,
  maxPerProject: config.retentionMaxPerProject,
  now: () => new Date(),
  carrying: () => worker.carrying,
  logger,
});
const retentionAbort = new AbortController();
let sweeping: Promise<void> | undefined;
const sweep = () => {
  sweeping ??= retention
    .sweep(retentionAbort.signal)
    .then(() => undefined)
    .catch((error: unknown) => {
      if (!retentionAbort.signal.aborted) {
        logger.error(`Working copy retention failed: ${(error as Error).message}`);
      }
    })
    .finally(() => (sweeping = undefined));
};
sweep();
const retentionTimer = setInterval(sweep, RETENTION_INTERVAL_MS);
retentionTimer.unref();

let shuttingDown = false;
const shutDown = (signal: string) => {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info(`${signal} received: stopping.`);
  clearInterval(retentionTimer);
  retentionAbort.abort();
  void Promise.all([worker.stop(), sweeping]).then(() => process.exit(0));
};
process.on('SIGTERM', () => shutDown('SIGTERM'));
process.on('SIGINT', () => shutDown('SIGINT'));

logger.info(`Polling ${config.apiUrl} every ${config.pollMs} ms.`);
await worker.run();
