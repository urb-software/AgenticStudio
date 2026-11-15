import type { Provider } from '@agentic-studio/contracts';
import { type ChildProcess, spawn, type SpawnOptions } from 'node:child_process';
import type { ProviderGate } from './provider-gate.js';

export interface ProviderCliRequest {
  provider: Provider;
  /** The provider CLI binary. */
  command: string;
  /** Arguments as an array: there is never a shell. */
  args: readonly string[];
  options?: Omit<SpawnOptions, 'shell'>;
}

/**
 * The spawn boundary (Issue #101): the only place in the agent worker's production code that
 * creates a provider CLI process (an architecture gate forbids `node:child_process` anywhere
 * else). It checks the provider's switch itself, so no code path, however it reached here,
 * starts a CLI for a disabled provider. Real runners (#105, #106) start their CLI through it.
 * Throws {@link ProviderDisabledError} before anything is spawned.
 */
export function spawnProviderCli(gate: ProviderGate, request: ProviderCliRequest): ChildProcess {
  gate.assertEnabled(request.provider);
  return spawn(request.command, [...request.args], { ...request.options, shell: false });
}
