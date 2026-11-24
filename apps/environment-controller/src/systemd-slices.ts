import { PREVIEW_LIMIT_BOUNDS, type PreviewBuildLimits } from '@agentic-studio/contracts';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { sliceName } from './compose-files.js';
import { OperationAborted, OperationFailure } from './failure.js';
import type { PreviewIdentity, PreviewSlices } from './ports.js';
import type { ProcessRunner } from './process-runner.js';

/** Room for the daemon itself on top of a build's memory: dockerd, containerd, rootlesskit and the shims. */
export const BUILD_DAEMON_HEADROOM_MIB = 512;

/**
 * The Preview user's `app.slice` holds the rootless daemon and BuildKit's build cgroups (build
 * steps run in a cgroup of their own directly below it, not in the daemon's unit). Previews run in
 * their own slices and the controller in its own, so a build bound does not touch either.
 */
const BUILD_BOUND_UNIT = 'app.slice';

const limitsFailed = (detail: string) => new OperationFailure('limits_failed', detail);

function checked(value: number, bounds: { min: number; max: number }, name: string): number {
  if (!Number.isInteger(value) || value < bounds.min || value > bounds.max) {
    throw limitsFailed(`The ${name} limit is out of range.`);
  }
  return value;
}

/** The unit file of one Preview's slice, built from validated integers only. */
export function renderSlice(limits: PreviewBuildLimits): string {
  const memory = checked(limits.memoryMiB, PREVIEW_LIMIT_BOUNDS.memoryMiB, 'memory');
  const cpu = checked(limits.cpuPercent, PREVIEW_LIMIT_BOUNDS.cpuPercent, 'CPU');
  const tasks = checked(limits.tasksMax, PREVIEW_LIMIT_BOUNDS.tasksMax, 'task');
  return `[Slice]\nMemoryMax=${memory}M\nMemorySwapMax=0\nCPUQuota=${cpu}%\nTasksMax=${tasks}\n`;
}

/** One systemd user slice per Preview, in the Preview user's own configuration directory. */
export class SystemdSlices implements PreviewSlices {
  constructor(
    private readonly options: {
      runner: ProcessRunner;
      /** `~/.config/systemd/user`. */
      directory: string;
      env: Record<string, string>;
      killGraceMs?: number;
    },
  ) {}

  async apply(
    identity: PreviewIdentity,
    limits: PreviewBuildLimits,
    signal: AbortSignal,
  ): Promise<void> {
    const content = renderSlice(limits);
    await mkdir(this.options.directory, { recursive: true, mode: 0o755 });
    await writeFile(join(this.options.directory, sliceName(identity.composeProject)), content, {
      mode: 0o644,
    });
    await this.reload(signal);
  }

  async boundBuild(
    _identity: PreviewIdentity,
    limits: PreviewBuildLimits,
    signal: AbortSignal,
  ): Promise<void> {
    const memory = checked(limits.memoryMiB, PREVIEW_LIMIT_BOUNDS.memoryMiB, 'memory');
    const cpu = checked(limits.cpuPercent, PREVIEW_LIMIT_BOUNDS.cpuPercent, 'CPU');
    const result = await this.options.runner.run({
      binary: 'systemctl',
      args: [
        '--user',
        'set-property',
        '--runtime',
        BUILD_BOUND_UNIT,
        `MemoryMax=${memory + BUILD_DAEMON_HEADROOM_MIB}M`,
        'MemorySwapMax=0',
        `CPUQuota=${cpu}%`,
      ],
      env: this.options.env,
      timeoutMs: 30_000,
      signal,
      graceMs: this.options.killGraceMs,
    });
    if (result.interrupted === 'aborted') throw new OperationAborted();
    if (result.exitCode !== 0) throw limitsFailed('systemd could not bound the build.');
  }

  async remove(identity: PreviewIdentity, signal: AbortSignal): Promise<void> {
    await rm(join(this.options.directory, sliceName(identity.composeProject)), { force: true });
    await this.reload(signal);
  }

  private async reload(signal: AbortSignal): Promise<void> {
    const result = await this.options.runner.run({
      binary: 'systemctl',
      args: ['--user', 'daemon-reload'],
      env: this.options.env,
      timeoutMs: 30_000,
      signal,
      graceMs: this.options.killGraceMs,
    });
    if (result.interrupted === 'aborted') throw new OperationAborted();
    if (result.exitCode !== 0) throw limitsFailed('systemd could not reload the slice.');
  }
}
