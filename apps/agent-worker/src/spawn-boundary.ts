import type { Provider } from '@agentic-studio/contracts';
import { type ChildProcess, spawn, type SpawnOptions } from 'node:child_process';
import type { ProviderGate } from './provider-gate.js';

/** Where each provider's CLI binary is: a command name on PATH or an absolute path. */
export type ProviderBinaries = Readonly<Record<Provider, string>>;

/** What the spawn boundary needs: the provider gate and the configured provider binaries. */
export interface ProviderCli {
  gate: ProviderGate;
  binaries: ProviderBinaries;
}

export interface ProviderCliRequest {
  provider: Provider;
  /** Arguments as an array: there is never a shell. The binary comes from the provider. */
  args: readonly string[];
  options?: Omit<SpawnOptions, 'shell'>;
}

/**
 * The spawn boundary (Issue #101): the only place in the agent worker's production code that
 * creates a provider CLI process (an architecture gate forbids `node:child_process` anywhere
 * else). It checks the provider's switch itself, so no code path, however it reached here,
 * starts a CLI for a disabled provider, and it starts only that provider's own configured
 * binary: callers pass arguments, never the command. Real runners (#105, #106) start their CLI
 * through it. Throws {@link ProviderDisabledError} before anything is spawned.
 */
export function spawnProviderCli(cli: ProviderCli, request: ProviderCliRequest): ChildProcess {
  cli.gate.assertEnabled(request.provider);
  return spawn(cli.binaries[request.provider], [...request.args], {
    ...request.options,
    shell: false,
  });
}
