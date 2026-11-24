import type { OperationRuntime, PreviewLogStream } from '@agentic-studio/contracts';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { OperationAborted, OperationFailure, type FailureCode } from './failure.js';
import {
  COMPOSE_SERVICE_LABEL,
  isOwned,
  OWNER_LABEL,
  OWNER_VALUE,
  PROJECT_LABEL,
} from './ownership.js';
import type { ContainerRuntime, PreviewIdentity, PreviewRun, RuntimeCall } from './ports.js';
import type { ProcessResult, ProcessRunner } from './process-runner.js';
import type { SocketBridges } from './socket-bridge.js';

const COMPOSE_PROJECT_LABEL = 'com.docker.compose.project';
const LISTING_TIMEOUT_MS = 60_000;
const REMOVAL_TIMEOUT_MS = 5 * 60_000;
const SERVICES_MAX = 100;

export interface DockerRuntimeOptions {
  runner: ProcessRunner;
  bridges: SocketBridges;
  /** The controller's own directory; holds the empty HOME of the calls that need no build. */
  dataDir: string;
  path: string;
  dockerHost: string;
  xdgRuntimeDir: string;
}

interface Inspected {
  Id?: string;
  Name?: string;
  Config?: { Labels?: Record<string, string> | null };
  Labels?: Record<string, string> | null;
  State?: { Status?: string; Running?: boolean };
  NetworkSettings?: { Networks?: Record<string, { IPAddress?: string }> };
}

const labelsOf = (item: Inspected) => item.Config?.Labels ?? item.Labels ?? null;

/** Compose arguments shared by `build` and `up`: nothing is read from the source tree's own config. */
export function composeArguments(run: PreviewRun, subcommand: readonly string[]): string[] {
  return [
    'compose',
    '--ansi',
    'never',
    '--progress',
    'plain',
    '--project-name',
    run.composeProject,
    '--project-directory',
    run.layout.srcDir,
    '--env-file',
    run.layout.emptyEnvFile,
    '-f',
    run.layout.stackFile,
    '-f',
    run.layout.overrideFile,
    ...subcommand,
  ];
}

/**
 * Drives the Preview user's Docker through the Compose CLI. Everything that is removed or listed
 * is found by both ownership labels, re-checked in the inspected JSON and acted on by explicit
 * id, so a resource without both labels is never touched.
 */
export class DockerComposeRuntime implements ContainerRuntime {
  constructor(private readonly options: DockerRuntimeOptions) {}

  async build(run: PreviewRun, call: RuntimeCall): Promise<void> {
    const result = await this.compose(run, ['build'], call, 'build');
    this.require(result, 'build_failed', 'The Compose build failed');
  }

  async start(run: PreviewRun, call: RuntimeCall): Promise<void> {
    const up = await this.compose(
      run,
      ['up', '--detach', '--no-build', '--remove-orphans', '--pull', 'missing'],
      call,
      'start',
    );
    this.require(up, 'start_failed', 'Compose could not start the services');

    const env = this.adminEnvironment(run.layout.homeDir, run.layout.dockerConfigDir);
    const entry = (await this.ownedContainers(run, env, call)).find(
      (container) =>
        labelsOf(container)?.[COMPOSE_SERVICE_LABEL] === run.service &&
        labelsOf(container)?.[COMPOSE_PROJECT_LABEL] === run.composeProject,
    );
    if (!entry?.State?.Running || !entry.Id) {
      throw new OperationFailure('start_failed', 'The entry service is not running after start.');
    }
    const address = Object.values(entry.NetworkSettings?.Networks ?? {})
      .map((network) => network.IPAddress ?? '')
      .find((value) => value !== '');
    if (!address) throw new OperationFailure('start_failed', 'The entry service has no address.');
    await this.options.bridges.create({
      previewLabel: run.previewLabel,
      address,
      port: run.port,
      containerId: entry.Id,
    });
  }

  async removeContainers(identity: PreviewIdentity, call: RuntimeCall): Promise<void> {
    await this.options.bridges.remove(identity.previewLabel);
    const env = await this.adminEnvironmentFor();
    const containers = await this.ownedContainers(identity, env, call);
    await this.removeByIds(
      ['rm', '--force', '--volumes'],
      containers.map((c) => c.Id),
      env,
      call,
    );
    const networks = await this.ownedResources('network', identity, env, call);
    await this.removeByIds(
      ['network', 'rm'],
      networks.map((n) => n.Id),
      env,
      call,
    );
  }

  async removeVolumes(identity: PreviewIdentity, call: RuntimeCall): Promise<void> {
    const env = await this.adminEnvironmentFor();
    const volumes = await this.ownedResources('volume', identity, env, call);
    await this.removeByIds(
      ['volume', 'rm'],
      volumes.map((v) => v.Name),
      env,
      call,
    );
  }

  async state(identity: PreviewIdentity, call: RuntimeCall): Promise<OperationRuntime> {
    const env = await this.adminEnvironmentFor();
    const containers = await this.ownedContainers(identity, env, call);
    return {
      services: containers.slice(0, SERVICES_MAX).map((container) => ({
        name: (
          labelsOf(container)?.[COMPOSE_SERVICE_LABEL] ??
          container.Name?.replace(/^\//, '') ??
          'unknown'
        ).slice(0, 255),
        state: (container.State?.Status ?? 'unknown').slice(0, 64),
      })),
    };
  }

  async close(): Promise<void> {
    await this.options.bridges.closeAll();
  }

  private compose(
    run: PreviewRun,
    subcommand: readonly string[],
    call: RuntimeCall,
    stream: PreviewLogStream,
  ): Promise<ProcessResult> {
    return this.execute(
      composeArguments(run, subcommand),
      run.environment,
      call,
      (line) => call.onLine(stream, line),
      24 * 60 * 60_000,
    );
  }

  private async execute(
    args: readonly string[],
    env: Record<string, string>,
    call: RuntimeCall,
    onLine?: (line: string) => void,
    timeoutMs = LISTING_TIMEOUT_MS,
  ): Promise<ProcessResult> {
    const result = await this.options.runner.run({
      binary: 'docker',
      args,
      env,
      timeoutMs,
      signal: call.signal,
      graceMs: call.killGraceMs,
      onLine: onLine ? (_stream, line) => onLine(line) : undefined,
    });
    if (result.interrupted === 'aborted' || result.interrupted === 'timeout') {
      throw new OperationAborted();
    }
    if (result.interrupted !== null) {
      throw new OperationFailure('runtime_failed', 'Docker could not be started.');
    }
    return result;
  }

  private require(result: ProcessResult, code: FailureCode, what: string): void {
    if (result.exitCode !== 0) {
      throw new OperationFailure(code, `${what} (exit code ${result.exitCode ?? 'none'}).`);
    }
  }

  /** The Compose-less calls get an empty HOME and DOCKER_CONFIG, like every Compose call. */
  private adminEnvironment(home: string, dockerConfig: string): Record<string, string> {
    return {
      PATH: this.options.path,
      HOME: home,
      DOCKER_CONFIG: dockerConfig,
      DOCKER_HOST: this.options.dockerHost,
      XDG_RUNTIME_DIR: this.options.xdgRuntimeDir,
    };
  }

  private async adminEnvironmentFor(): Promise<Record<string, string>> {
    const home = join(this.options.dataDir, 'docker-admin', 'home');
    const config = join(this.options.dataDir, 'docker-admin', 'config');
    await mkdir(home, { recursive: true, mode: 0o700 });
    await mkdir(config, { recursive: true, mode: 0o700 });
    return this.adminEnvironment(home, config);
  }

  private labelFilters(identity: PreviewIdentity): string[] {
    return [
      '--filter',
      `label=${OWNER_LABEL}=${OWNER_VALUE}`,
      '--filter',
      `label=${PROJECT_LABEL}=${identity.projectId}`,
    ];
  }

  /** The ids the daemon lists for both labels, then the inspected JSON checked for both again. */
  private async ownedResources(
    kind: 'container' | 'network' | 'volume',
    identity: PreviewIdentity,
    env: Record<string, string>,
    call: RuntimeCall,
  ): Promise<{ Id: string; Name: string; item: Inspected }[]> {
    const listing =
      kind === 'container'
        ? ['ps', '--all', '--no-trunc', '--quiet', ...this.labelFilters(identity)]
        : [kind, 'ls', '--quiet', ...this.labelFilters(identity)];
    const listed = await this.execute(listing, env, call);
    this.require(listed, 'runtime_failed', `Docker could not list ${kind}s`);
    const ids = listed.stdout
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line !== '');
    if (ids.length === 0) return [];
    const inspected = await this.execute([kind, 'inspect', ...ids], env, call);
    this.require(inspected, 'runtime_failed', `Docker could not inspect ${kind}s`);
    let items: Inspected[];
    try {
      items = JSON.parse(inspected.stdout) as Inspected[];
    } catch {
      throw new OperationFailure('runtime_failed', 'Docker answered with something unreadable.');
    }
    return items
      .filter((item) => isOwned(labelsOf(item), identity.projectId))
      .map((item) => ({ Id: item.Id ?? item.Name ?? '', Name: item.Name ?? item.Id ?? '', item }))
      .filter((item) => item.Id !== '');
  }

  private async ownedContainers(
    identity: PreviewIdentity,
    env: Record<string, string>,
    call: RuntimeCall,
  ): Promise<Inspected[]> {
    return (await this.ownedResources('container', identity, env, call)).map((r) => r.item);
  }

  private async removeByIds(
    prefix: string[],
    ids: (string | undefined)[],
    env: Record<string, string>,
    call: RuntimeCall,
  ): Promise<void> {
    const explicit = ids.filter((id): id is string => !!id);
    if (explicit.length === 0) return;
    const result = await this.execute(
      [...prefix, ...explicit],
      env,
      call,
      undefined,
      REMOVAL_TIMEOUT_MS,
    );
    this.require(result, 'runtime_failed', 'Docker could not remove resources');
  }
}
