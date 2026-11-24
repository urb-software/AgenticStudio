import { readFile } from 'node:fs/promises';
import { OperationAborted, OperationFailure } from './failure.js';
import type { EgressRules } from './ports.js';
import type { ProcessRunner } from './process-runner.js';

const missing = () =>
  new OperationFailure('egress_rules_missing', 'The Preview egress rules are not in place.');

/**
 * Reads back the egress rules by running the root-owned script's `verify`, inside the rootless
 * daemon's namespace through `nsenter`. The controller never applies them; anything but
 * success means the rules are missing.
 */
export class ScriptEgressRules implements EgressRules {
  constructor(
    private readonly options: {
      runner: ProcessRunner;
      /** Absolute path of the script, as the `nsenter` argument. */
      script: string;
      rootless: boolean;
      /** The file in which the rootless daemon records its network namespace holder's pid. */
      childPidFile: string;
      env: Record<string, string>;
      killGraceMs?: number;
    },
  ) {}

  async verify(signal: AbortSignal): Promise<void> {
    const { runner, rootless, env } = this.options;
    let command: { binary: 'nsenter' | 'egress-rules'; args: string[] };
    if (rootless) {
      const pid = Number(
        (await readFile(this.options.childPidFile, 'utf8').catch(() => '')).trim(),
      );
      if (!Number.isInteger(pid) || pid < 2) throw missing();
      command = {
        binary: 'nsenter',
        args: [
          '-U',
          '--preserve-credentials',
          '-n',
          '-t',
          String(pid),
          this.options.script,
          'verify',
        ],
      };
    } else {
      command = { binary: 'egress-rules', args: ['verify'] };
    }
    const result = await runner.run({
      ...command,
      env,
      timeoutMs: 30_000,
      signal,
      graceMs: this.options.killGraceMs,
    });
    if (result.interrupted === 'aborted') throw new OperationAborted();
    if (result.exitCode !== 0) throw missing();
  }
}
