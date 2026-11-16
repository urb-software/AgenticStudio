import { AgentSessions } from './agent-sessions.js';
import { ClaudeCodeRunner, probeClaudeCode } from './claude-code/runner.js';
import { prepareCodexHome } from './codex/codex-home.js';
import { CodexRunner, probeCodex } from './codex/runner.js';
import { assertSupportedPlatform, loadWorkerConfig, type WorkerConfig } from './config.js';
import { BranchUpdates } from './branch-update.js';
import { Deliveries } from './delivery.js';
import { DiskMonitor } from './disk.js';
import { FakeRunner } from './fake-runner.js';
import { GitRunner } from './git.js';
import { terminateLeftovers } from './leftovers.js';
import { ManagedGuardrails } from './managed-guardrails.js';
import { RETENTION_INTERVAL_MS, Retention } from './retention.js';
import { RunDiffs } from './run-diff.js';
import { DockerRunResources } from './run-resources.js';
import { ProviderGate } from './provider-gate.js';
import { PullRequestLookups } from './pull-request-lookups.js';
import { RunnerDispatcher } from './runner-dispatcher.js';
import { StudioApi } from './studio-api.js';
import { AgentWorker, type WorkerLogger } from './worker.js';
import { loadWorkerId } from './worker-identity.js';
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
const switches = new ProviderGate(config.providers);
// Issue #105: a switched-on Claude Code whose CLI is missing or of an unsupported version is
// unavailable (with the reason) for the life of the process. The check starts `claude
// --version` through the spawn boundary, so only when the switch is on and the CLI is used.
// Issue #106: the same for Codex, which must also be a complete standalone install.
const unavailable: { claude_code?: string; codex?: string } = {};
if (config.runner === 'cli' && switches.isEnabled('claude_code')) {
  const check = await probeClaudeCode(
    { gate: switches, binaries: config.providerBinaries },
    process.env,
  );
  if (!check.ok) unavailable.claude_code = check.reason;
}
if (config.runner === 'cli' && switches.isEnabled('codex')) {
  const check = await probeCodex(
    { gate: switches, binaries: config.providerBinaries },
    process.env,
  );
  if (!check.ok) unavailable.codex = check.reason;
}
// Issue #134: Studio's guardrails for both CLIs are root-owned managed files the server setup
// installs; a switched-on provider whose files are missing or changed is unavailable.
if (config.runner === 'cli') {
  const managed = new ManagedGuardrails();
  for (const provider of ['claude_code', 'codex'] as const) {
    if (!switches.isEnabled(provider) || unavailable[provider] !== undefined) continue;
    const problem = await managed.problem(provider);
    if (problem !== null) unavailable[provider] = problem;
  }
}
const gate = new ProviderGate(config.providers, unavailable);
const cli = { gate, binaries: config.providerBinaries };
// The agent user's own environment and Git configuration (its Git credentials live there).
const git = new GitRunner();
const fake = new FakeRunner({ git });
// Fake mode is refused in production by loadWorkerConfig. Every runner sits behind the
// dispatcher, which checks the provider gate before every Run step.
const runner = new RunnerDispatcher(
  gate,
  config.runner === 'fake'
    ? { claude_code: fake, codex: fake }
    : {
        claude_code: new ClaudeCodeRunner({
          cli,
          git,
          env: process.env,
          maxTurns: config.claudeMaxTurns,
        }),
        codex: new CodexRunner({
          cli,
          git,
          env: process.env,
          sandbox: config.codexSandbox,
          dataDir: config.dataDir,
        }),
      },
);
const reasons = gate.reasons();

// Kept in the data directory across restarts: a delivery retry goes to the worker that started
// the Run, which holds its Working copy (Issue #102, review R4 of #122).
const workerId = await loadWorkerId(config.dataDir);
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
const resources = new DockerRunResources(undefined, logger);
// Issue #143: the disk figures for the status report and the free-space guard of new Runs.
const disk = new DiskMonitor({
  dataDir: config.dataDir,
  minFreeBytes: config.minFreeBytes,
  now: () => new Date(),
  logger,
});
const workingCopies = new WorkingCopies({
  dataDir: config.dataDir,
  git,
  freeSpace: disk,
  agentGitName: config.agentGitName,
  agentGitEmail: config.agentGitEmail,
  // A local (file) remote only for a development or test worker (coordinator decision, #98).
  allowFileRemotes: config.environment !== 'production',
  logger,
});
const worker = new AgentWorker({
  api,
  runner,
  gate,
  resources,
  status: {
    runner: config.runner,
    providers: gate.snapshot(),
    ...(Object.keys(reasons).length > 0 ? { providerReasons: { ...reasons } } : {}),
  },
  disk,
  workingCopies,
  // Issue #147: the integration branch merged into a Run branch on the operator's request.
  branchUpdates: new BranchUpdates({
    dataDir: config.dataDir,
    git,
    workingCopies,
    agentGitName: config.agentGitName,
    agentGitEmail: config.agentGitEmail,
    logger,
  }),
  // Issue #102: the Agent account's token stays on the agent side (the worker's own .env).
  deliveries: new Deliveries({
    dataDir: config.dataDir,
    git,
    agentGitName: config.agentGitName,
    agentGitEmail: config.agentGitEmail,
    allowFileRemotes: config.environment !== 'production',
    github: config.agentGitHub,
    logger,
  }),
  // Issue #142: the state of a Run's pull request, read through the Agent account (reads only).
  lookups: new PullRequestLookups({
    api,
    github: config.agentGitHub,
    allowFileRemotes: config.environment !== 'production',
    logger,
  }),
  // Issue #144: the Run's diffs, within the configured limits.
  diffs: new RunDiffs({ dataDir: config.dataDir, git, limits: config.diffLimits, logger }),
  pollMs: config.pollMs,
  heartbeatMs: config.heartbeatMs,
  killGraceMs: config.killGraceMs,
  logger,
});

// Issue #100: a previous worker that crashed during a Run step may have left its processes
// and containers behind. Stop them before anything else runs; the Run is not resumed (Studio
// fails it as worker_lost). A failure is logged and the next start tries again.
try {
  await terminateLeftovers({
    dataDir: config.dataDir,
    resources,
    logger,
    graceMs: config.killGraceMs,
  });
} catch (error) {
  logger.error(`Cleaning up after a previous worker failed: ${(error as Error).message}`);
}

// Working copy retention (Issue #98): at start (which also removes leftover directories
// without a known Run) and hourly; a failed pass is logged and retried at the next one.
const retention = new Retention({
  dataDir: config.dataDir,
  runStates: (runIds, signal, removedRunIds) => api.runStates(runIds, signal, removedRunIds),
  resources,
  // Issue #143: the provider CLIs' session files of a removed Working copy go with it.
  ...(process.env.HOME?.startsWith('/') && process.env.HOME !== '/'
    ? { sessions: new AgentSessions(process.env.HOME, logger) }
    : {}),
  carrying: () => worker.carrying,
  logger,
});
const retentionAbort = new AbortController();
let sweeping: Promise<void> | undefined;
// Issue #106: a removed Working copy's untrusted entry leaves Studio's Codex configuration with it.
const codexInUse = config.runner === 'cli' && gate.isEnabled('codex');
const sweep = () => {
  sweeping ??= retention
    .sweep(retentionAbort.signal)
    .then(async (outcome) => {
      const home = process.env.HOME;
      if (!codexInUse || outcome.removed.length === 0 || !home || !home.startsWith('/')) return;
      await prepareCodexHome({ home, dataDir: config.dataDir }).catch((error: unknown) => {
        logger.error(`Rewriting Studio's Codex configuration failed: ${(error as Error).message}`);
      });
    })
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
  .filter(([provider, on]) => on && gate.isEnabled(provider as 'claude_code' | 'codex'))
  .map(([provider]) => provider);
logger.info(
  `Runner mode ${config.runner} (${config.environment}); providers enabled: ` +
    `${enabled.length > 0 ? enabled.join(', ') : 'none'}.`,
);
for (const [provider, reason] of Object.entries(reasons)) {
  logger.error(`Provider ${provider} is switched on but unavailable: ${reason}`);
}
logger.info(`Polling ${config.apiUrl} every ${config.pollMs} ms.`);
await worker.run();
