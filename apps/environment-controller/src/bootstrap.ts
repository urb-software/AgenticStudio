import { randomUUID } from 'node:crypto';
import { chmod, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { EnvironmentController } from './controller.js';
import { DesiredStates } from './desired-state.js';
import { DockerComposeRuntime } from './docker-compose-runtime.js';
import { ScriptEgressRules } from './egress-rules.js';
import type { ControllerConfig } from './config.js';
import { FakeRuntime, type FakeRuntimeOptions } from './fake-runtime.js';
import type { ControllerLogger } from './logger.js';
import type { ContainerRuntime, EgressRules, PreviewSlices } from './ports.js';
import { PreviewOperations } from './preview-operations.js';
import { DEFAULT_BINARIES, NodeProcessRunner, type ProcessRunner } from './process-runner.js';
import { NodeProxyBridges, NsenterSocatBridges, type SocketBridges } from './socket-bridge.js';
import { StudioApi } from './studio-api.js';
import { SystemdSlices } from './systemd-slices.js';

export interface Runtime {
  runtime: ContainerRuntime;
  slices: PreviewSlices;
  egress: EgressRules;
  /** The fake, when that is what runs; tests read what it recorded. */
  fake?: FakeRuntime;
}

const DEFAULT_PATH = '/usr/local/bin:/usr/bin:/bin';

/** The runtime the settings ask for: the fake, or Docker Compose with systemd slices. */
export function createRuntime(
  config: ControllerConfig,
  runner: ProcessRunner,
  fakeOptions?: FakeRuntimeOptions,
): Runtime {
  if (config.runtime === 'fake' || config.docker === null) {
    const fake = new FakeRuntime(fakeOptions);
    return { runtime: fake, slices: fake, egress: fake, fake };
  }
  const { home, xdgRuntimeDir, dockerHost } = config.docker;
  const path = process.env.PATH ?? DEFAULT_PATH;
  const childPidFile = join(xdgRuntimeDir, 'dockerd-rootless', 'child_pid');
  const env = { PATH: path, HOME: home, XDG_RUNTIME_DIR: xdgRuntimeDir, DOCKER_HOST: dockerHost };
  const bridges: SocketBridges = config.rootless
    ? new NsenterSocatBridges({
        runner,
        dir: config.proxyDir,
        proxyGid: config.proxyGid,
        childPidFile,
        env,
        killGraceMs: config.killGraceMs,
      })
    : new NodeProxyBridges({ dir: config.proxyDir, proxyGid: config.proxyGid });
  return {
    runtime: new DockerComposeRuntime({
      runner,
      bridges,
      dataDir: config.dataDir,
      path,
      dockerHost,
      xdgRuntimeDir,
    }),
    slices: new SystemdSlices({
      runner,
      directory: join(home, '.config', 'systemd', 'user'),
      env,
      killGraceMs: config.killGraceMs,
    }),
    egress: new ScriptEgressRules({
      runner,
      script: config.egressRulesBin,
      rootless: config.rootless,
      childPidFile,
      env,
      killGraceMs: config.killGraceMs,
    }),
  };
}

export interface BuiltController {
  controller: EnvironmentController;
  runtime: Runtime;
  controllerId: string;
}

/** Composes the controller from its settings; the one place the pieces are wired together. */
export async function buildController(
  config: ControllerConfig,
  logger: ControllerLogger,
  options: { fakeOptions?: FakeRuntimeOptions; fetch?: typeof fetch; runner?: ProcessRunner } = {},
): Promise<BuiltController> {
  await mkdir(config.dataDir, { recursive: true, mode: 0o700 });
  await chmod(config.dataDir, 0o700);
  const controllerId = randomUUID();
  const runner =
    options.runner ??
    new NodeProcessRunner({ ...DEFAULT_BINARIES, 'egress-rules': config.egressRulesBin });
  const runtime = createRuntime(config, runner, options.fakeOptions);
  const api = new StudioApi({
    apiUrl: config.apiUrl,
    token: config.token,
    controllerId,
    timeoutMs: config.requestTimeoutMs,
    fetch: options.fetch,
  });
  const operations = new PreviewOperations({
    dataDir: config.dataDir,
    minFreeBytes: config.minFreeBytes,
    killGraceMs: config.killGraceMs,
    compose: {
      PATH: process.env.PATH ?? DEFAULT_PATH,
      DOCKER_HOST: config.docker?.dockerHost ?? 'unix:///fake',
      XDG_RUNTIME_DIR: config.docker?.xdgRuntimeDir ?? '/tmp',
    },
    fetchSource: (operationId, signal) => api.fetchSource(operationId, signal),
    runtime: runtime.runtime,
    slices: runtime.slices,
    egress: runtime.egress,
    desired: new DesiredStates(config.dataDir),
  });
  const controller = new EnvironmentController({
    api,
    operations,
    logger,
    pollMs: config.pollMs,
    heartbeatMs: config.heartbeatMs,
  });
  return { controller, runtime, controllerId };
}
