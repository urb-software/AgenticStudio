import { randomUUID } from 'node:crypto';
import { MissingCliRunner } from './cli-runner.js';
import { assertSupportedPlatform, loadWorkerConfig, type WorkerConfig } from './config.js';
import { FakeRunner } from './fake-runner.js';
import { ProviderGate } from './provider-gate.js';
import { RunnerDispatcher } from './runner-dispatcher.js';
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

// The provider switches were read once, above; a change takes a restart (Issue #101).
const gate = new ProviderGate(config.providers);
const fake = new FakeRunner();
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
const worker = new AgentWorker({
  api: new StudioApi({
    apiUrl: config.apiUrl,
    token: config.token,
    workerId,
    timeoutMs: config.requestTimeoutMs,
  }),
  runner,
  status: { runner: config.runner, providers: gate.snapshot() },
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

const enabled = Object.entries(gate.snapshot())
  .filter(([, on]) => on)
  .map(([provider]) => provider);
logger.info(
  `Runner mode ${config.runner} (${config.environment}); providers enabled: ` +
    `${enabled.length > 0 ? enabled.join(', ') : 'none'}.`,
);
logger.info(`Polling ${config.apiUrl} every ${config.pollMs} ms.`);
await worker.run();
