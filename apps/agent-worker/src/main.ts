import { randomUUID } from 'node:crypto';
import { MissingCliRunner } from './cli-runner.js';
import { assertSupportedPlatform, loadWorkerConfig, type WorkerConfig } from './config.js';
import { FakeRunner } from './fake-runner.js';
import { GitRunner } from './git.js';
import { RETENTION_INTERVAL_MS, Retention } from './retention.js';
import { DockerRunResources } from './run-resources.js';
import { ProviderGate } from './provider-gate.js';
import { RunnerDispatcher } from './runner-dispatcher.js';
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

// The provider switches were read once, above; a change takes a restart (Issue #101).
const gate = new ProviderGate(config.providers);
// The agent user's own environment and Git configuration (its Git credentials live there).
const git = new GitRunner();
const fake = new FakeRunner({ git });
// Fake mode is refused in production by loadWorkerConfig. Every runner sits behind the
// dispatcher, which checks the provider gate before every Run step.
const runner = new RunnerDispatcher(
  gate,
  config.runner === 'fake'
    ? { claude_code: fake, codex: fake }
    : { claude_code: new MissingCliRunner('claude_code'), codex: new MissingCliRunner('codex') },
);

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
const worker = new AgentWorker({
  api,
  runner,
  status: { runner: config.runner, providers: gate.snapshot() },
  workingCopies: new WorkingCopies({
    dataDir: config.dataDir,
    git,
    agentGitName: config.agentGitName,
    agentGitEmail: config.agentGitEmail,
    // A local (file) remote only for a development or test worker (coordinator decision, #98).
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

const enabled = Object.entries(gate.snapshot())
  .filter(([, on]) => on)
  .map(([provider]) => provider);
logger.info(
  `Runner mode ${config.runner} (${config.environment}); providers enabled: ` +
    `${enabled.length > 0 ? enabled.join(', ') : 'none'}.`,
);
logger.info(`Polling ${config.apiUrl} every ${config.pollMs} ms.`);
await worker.run();
