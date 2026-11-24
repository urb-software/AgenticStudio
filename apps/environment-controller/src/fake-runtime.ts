import type { OperationRuntime, PreviewBuildLimits } from '@agentic-studio/contracts';
import { setTimeout as delay } from 'node:timers/promises';
import { OperationAborted, OperationFailure } from './failure.js';
import type {
  ContainerRuntime,
  EgressRules,
  PreviewIdentity,
  PreviewRun,
  PreviewSlices,
  RuntimeCall,
} from './ports.js';
import { RecordingBridges } from './socket-bridge.js';

export interface FakeRuntimeOptions {
  /** Fails `build` with this detail instead of succeeding. */
  failBuild?: string;
  /** Fails `start` with this detail. */
  failStart?: string;
  /** Makes `build` take this long (until it is aborted). */
  buildMs?: number;
  /** The egress rules check fails. */
  egressMissing?: boolean;
  /** Echo the Compose environment values in the build output, as a leaking tool would. */
  echoEnvironment?: boolean;
}

/**
 * A stand-in for Docker, systemd and the egress rules: it runs nothing and records what it was
 * asked to do. Its build output echoes the environment values it was given (by default), so a
 * test can prove they are redacted on the way to the log. Only for development and test.
 */
export class FakeRuntime implements ContainerRuntime, PreviewSlices, EgressRules {
  readonly events: string[] = [];
  readonly bridges = new RecordingBridges();
  readonly environments: Record<string, string>[] = [];
  readonly startEnvironments: Record<string, string>[] = [];
  readonly limits: PreviewBuildLimits[] = [];
  private readonly running = new Map<string, PreviewRun>();

  constructor(private readonly options: FakeRuntimeOptions = {}) {}

  async build(run: PreviewRun, call: RuntimeCall): Promise<void> {
    this.events.push(`build ${run.composeProject}`);
    this.environments.push(run.environment);
    call.onLine('build', `fake build of ${run.service}`);
    if (this.options.echoEnvironment !== false) {
      for (const [key, value] of Object.entries(run.environment)) {
        if (!['PATH', 'HOME', 'DOCKER_CONFIG', 'DOCKER_HOST', 'XDG_RUNTIME_DIR'].includes(key)) {
          call.onLine('build', `fake build: using ${key}=${value}`);
        }
      }
    }
    if (this.options.buildMs) await this.wait(this.options.buildMs, call.signal);
    if (this.options.failBuild) throw new OperationFailure('build_failed', this.options.failBuild);
  }

  async start(run: PreviewRun, call: RuntimeCall): Promise<void> {
    this.events.push(`start ${run.composeProject}`);
    this.startEnvironments.push(run.environment);
    call.onLine('start', `fake start of ${run.service}`);
    if (this.options.failStart) throw new OperationFailure('start_failed', this.options.failStart);
    this.running.set(run.projectId, run);
    await this.bridges.create({
      previewLabel: run.previewLabel,
      address: '127.0.0.1',
      port: run.port,
      containerId: `fake-${run.composeProject}`,
    });
    call.onLine('start', `fake bridge created for ${run.previewLabel}`);
  }

  async removeContainers(identity: PreviewIdentity, call: RuntimeCall): Promise<void> {
    this.events.push(`removeContainers ${identity.composeProject}`);
    if (this.bridges.open.includes(identity.previewLabel)) {
      call.onLine('controller', `fake bridge removed for ${identity.previewLabel}`);
    }
    await this.bridges.remove(identity.previewLabel);
    this.running.delete(identity.projectId);
  }

  async removeVolumes(identity: PreviewIdentity): Promise<void> {
    this.events.push(`removeVolumes ${identity.composeProject}`);
  }

  async state(identity: PreviewIdentity): Promise<OperationRuntime> {
    this.events.push(`state ${identity.composeProject}`);
    const run = this.running.get(identity.projectId);
    return { services: run ? [{ name: run.service, state: 'running' }] : [] };
  }

  async close(): Promise<void> {
    this.events.push('close');
    await this.bridges.closeAll();
  }

  async apply(identity: PreviewIdentity, limits: PreviewBuildLimits): Promise<void> {
    this.events.push(`slice.apply ${identity.composeProject}`);
    this.limits.push(limits);
  }

  async remove(identity: PreviewIdentity): Promise<void> {
    this.events.push(`slice.remove ${identity.composeProject}`);
  }

  async verify(): Promise<void> {
    this.events.push('egress.verify');
    if (this.options.egressMissing) {
      throw new OperationFailure(
        'egress_rules_missing',
        'The Preview egress rules are not in place.',
      );
    }
  }

  private async wait(ms: number, signal: AbortSignal): Promise<void> {
    try {
      await delay(ms, undefined, { signal });
    } catch {
      throw new OperationAborted();
    }
  }
}
