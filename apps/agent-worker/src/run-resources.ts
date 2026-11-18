import { runProcess } from './process-runner.js';

/**
 * The containers, networks and volumes of a Run (everything its steps started under its Compose
 * project name), removed with its Working copy. Production talks to the agent user's own rootless
 * Docker, never the system daemon (ADR 0002).
 */
export interface RunResources {
  /** Stops and removes everything of this Compose project; throws if that failed. */
  cleanUp(composeProjectName: string, signal?: AbortSignal): Promise<void>;
}

/** Runs `docker <args>`; resolves with standard output, rejects on a non-zero exit. */
export type DockerExec = (args: readonly string[], signal?: AbortSignal) => Promise<string>;

/** Docker is not installed for the agent user: there is nothing of a Run to remove. */
export class DockerMissingError extends Error {
  constructor() {
    super('docker is not installed');
    this.name = 'DockerMissingError';
  }
}

const COMPOSE_PROJECT = /^studio-run-[0-9a-f]{12}$/;

/** The time limit of one Docker command. */
const DOCKER_TIMEOUT_MS = 5 * 60_000;

/** `docker` from the PATH, without a shell, with a time limit, in the worker's environment. */
export function systemDocker(env: NodeJS.ProcessEnv = process.env): DockerExec {
  return async (args, signal) => {
    const result = await runProcess({
      binary: 'docker',
      args,
      env,
      timeoutMs: DOCKER_TIMEOUT_MS,
      signal,
    });
    if (result.interrupted === 'missing') throw new DockerMissingError();
    if (result.exitCode !== 0) {
      const why = result.interrupted ?? `exited with code ${result.exitCode}`;
      throw new Error(`docker ${args[0]} ${why}: ${result.stderr.trim()}`);
    }
    return result.stdout;
  };
}

const lines = (output: string) =>
  output
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '');

/**
 * Removes a Run's Compose project (`docker compose -p <name> down --volumes --remove-orphans`),
 * then whatever is still labelled with it, so resources started outside Compose's bookkeeping go
 * too. Without Docker there is nothing to remove.
 */
export class DockerRunResources implements RunResources {
  constructor(
    private readonly docker: DockerExec = systemDocker(),
    private readonly logger: { error(message: string): void } = { error: () => undefined },
  ) {}

  async cleanUp(composeProjectName: string, signal?: AbortSignal): Promise<void> {
    if (!COMPOSE_PROJECT.test(composeProjectName)) {
      throw new Error("Refusing to clean up a Compose project that is not a Run's.");
    }
    const label = `label=com.docker.compose.project=${composeProjectName}`;
    try {
      try {
        await this.docker(
          ['compose', '-p', composeProjectName, 'down', '--volumes', '--remove-orphans'],
          signal,
        );
      } catch (error) {
        if (error instanceof DockerMissingError) throw error;
        // What is left is removed by its label below.
        this.logger.error(`docker compose down for ${composeProjectName} failed: ${String(error)}`);
      }
      const containers = lines(await this.docker(['ps', '-aq', '--filter', label], signal));
      if (containers.length > 0) {
        await this.docker(['rm', '--force', '--volumes', ...containers], signal);
      }
      const networks = lines(await this.docker(['network', 'ls', '-q', '--filter', label], signal));
      if (networks.length > 0) await this.docker(['network', 'rm', ...networks], signal);
      const volumes = lines(await this.docker(['volume', 'ls', '-q', '--filter', label], signal));
      if (volumes.length > 0) await this.docker(['volume', 'rm', '--force', ...volumes], signal);
    } catch (error) {
      if (error instanceof DockerMissingError) return;
      throw error;
    }
  }
}
