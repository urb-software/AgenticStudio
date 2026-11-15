import type { Provider } from '@agentic-studio/contracts';
import { type ChildProcess, spawn, type SpawnOptions } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
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
  options?: Omit<SpawnOptions, 'shell' | 'detached'>;
}

/**
 * Where a Run step's process groups are recorded (Issue #100), so the worker can stop the
 * whole tree of the step: `StepProcesses` in production.
 */
export interface ProcessGroupRegistry {
  register(processGroupId: number): void;
}

/**
 * The spawn boundary (Issue #101): the only place in the agent worker's production code that
 * creates a provider CLI process (an architecture gate forbids `node:child_process` anywhere
 * else). It checks the provider's switch itself, so no code path, however it reached here,
 * starts a CLI for a disabled provider, and it starts only that provider's own configured
 * binary: callers pass arguments, never the command. Real runners (#105, #106) start their CLI
 * through it. Throws {@link ProviderDisabledError} before anything is spawned.
 *
 * Issue #100: the CLI gets its own process group (`detached`), registered with the Run step's
 * `processes`, so stopping the step reaches every process the CLI started.
 */
export function spawnProviderCli(
  cli: ProviderCli,
  request: ProviderCliRequest,
  processes: ProcessGroupRegistry,
): ChildProcess {
  cli.gate.assertEnabled(request.provider);
  const child = spawn(cli.binaries[request.provider], [...request.args], {
    ...request.options,
    shell: false,
    detached: true,
  });
  // A detached child leads its own group: its pid is the group id.
  if (child.pid !== undefined) processes.register(child.pid);
  return child;
}

/**
 * Whether `id` can name a process group to signal. Never 0 or 1: `kill(-1)` would reach every
 * process of the agent user, and group 0 is the worker's own.
 */
export function isSignallableGroup(id: number): boolean {
  return Number.isSafeInteger(id) && id > 1;
}

/** Sends `signal` to every process of the group; false if no process of it can be reached. */
export function signalProcessGroup(id: number, signal: NodeJS.Signals | 0): boolean {
  if (!isSignallableGroup(id)) return false;
  try {
    process.kill(-id, signal);
    return true;
  } catch {
    // ESRCH: the group is gone; EPERM: not the agent user's, never ours to stop.
    return false;
  }
}

/** Whether any process of the group is still there for the agent user to stop. */
export function isProcessGroupAlive(id: number): boolean {
  return signalProcessGroup(id, 0);
}

const POLL_MS = 50;
/** How long the worker waits for killed groups to disappear. */
const KILL_WAIT_MS = 2000;

async function waitUntil(done: () => boolean, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (!done()) {
    if (Date.now() >= deadline) return false;
    await delay(POLL_MS);
  }
  return true;
}

export interface TerminateOptions {
  /** How long the processes get after the interrupt before they are killed. */
  graceMs: number;
  /** Also awaited within the grace (e.g. the runner's own end); never delays the kill past it. */
  settled?: Promise<unknown>;
}

/**
 * The termination helper (Issue #100): SIGINT to each process group (a CLI's own way to stop
 * cleanly), up to `graceMs` for every group to exit, then SIGKILL to whatever is left. Resolves
 * once the groups are gone (or after a short wait for the kill to land); never throws.
 * Returns the groups that had to be killed.
 */
export async function terminateProcessGroups(
  groups: readonly number[],
  options: TerminateOptions,
): Promise<number[]> {
  const live = groups.filter(isSignallableGroup);
  for (const id of live) signalProcessGroup(id, 'SIGINT');
  let settled = options.settled === undefined;
  void options.settled?.then(
    () => (settled = true),
    () => (settled = true),
  );
  await waitUntil(() => settled && live.every((id) => !isProcessGroupAlive(id)), options.graceMs);
  const stubborn = live.filter(isProcessGroupAlive);
  for (const id of stubborn) signalProcessGroup(id, 'SIGKILL');
  await waitUntil(() => stubborn.every((id) => !isProcessGroupAlive(id)), KILL_WAIT_MS);
  return stubborn;
}
