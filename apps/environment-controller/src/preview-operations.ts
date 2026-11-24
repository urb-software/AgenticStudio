import { MAX_TEXT_BYTES, validateCompose } from '@agentic-studio/compose-validation';
import {
  CONTROLLER_PROBLEM_TYPES,
  type OperationPayload,
  type OperationRuntime,
  PREVIEW_ARCHIVE_MAX_BYTES,
  PREVIEW_ARCHIVE_MAX_ENTRIES,
  PREVIEW_FAILURE_REFUSALS_MAX,
  type PreviewLogStream,
  type PreviewRefusal,
} from '@agentic-studio/contracts';
import {
  chmod,
  lstat,
  mkdir,
  readdir,
  readFile,
  realpath,
  rm,
  statfs,
  writeFile,
} from 'node:fs/promises';
import { dirname, join, relative, sep } from 'node:path';
import { composeEnvironment, type ComposeBase } from './compose-environment.js';
import { renderOverride, renderStack } from './compose-files.js';
import type { DesiredStates } from './desired-state.js';
import { writeEnvironmentFile } from './environment-file.js';
import { OperationAborted, OperationFailure } from './failure.js';
import { buildLayout, buildsDir, type BuildLayout, previewRoot } from './layout.js';
import type {
  ContainerRuntime,
  EgressRules,
  PreviewIdentity,
  PreviewRun,
  PreviewSlices,
  RuntimeCall,
} from './ports.js';
import { StudioApiError, type SourceDownload } from './studio-api.js';
import { ArchiveError, extractTar } from './tar-extract.js';

type BuildPayload = Extract<OperationPayload, { kind: 'build' }>;

export interface OperationContext {
  /** Aborted when the lease is lost or the controller shuts down. */
  signal: AbortSignal;
  log: (stream: PreviewLogStream, text: string) => void;
}

export interface OperationOutcome {
  runtime?: OperationRuntime;
}

export interface PreviewOperationsDeps {
  dataDir: string;
  minFreeBytes: number;
  killGraceMs: number;
  /** The fixed part of the Compose process environment. */
  compose: Pick<ComposeBase, 'PATH' | 'DOCKER_HOST' | 'XDG_RUNTIME_DIR'>;
  fetchSource: (operationId: string, signal: AbortSignal) => Promise<SourceDownload>;
  runtime: ContainerRuntime;
  slices: PreviewSlices;
  egress: EgressRules;
  desired: DesiredStates;
  /** Free bytes where `directory` lives; defaults to `statfs`. */
  freeBytes?: (directory: string) => Promise<number>;
  /** Milliseconds for a build of this many minutes; defaults to minutes * 60000. */
  deadlineMs?: (minutes: number) => number;
}

const ADMIN_TIMEOUT_MS = 10 * 60_000;

async function defaultFreeBytes(directory: string): Promise<number> {
  const stats = await statfs(directory);
  return Number(stats.bavail) * Number(stats.bsize);
}

const identityOf = (op: OperationPayload): PreviewIdentity => ({
  projectId: op.projectId,
  composeProject: op.composeProject,
  previewLabel: op.previewLabel,
});

/** The fixed operations: build, stop, remove data and state. Nothing else exists. */
export class PreviewOperations {
  constructor(private readonly deps: PreviewOperationsDeps) {}

  async execute(op: OperationPayload, context: OperationContext): Promise<OperationOutcome> {
    switch (op.kind) {
      case 'build':
        return this.build(op, context);
      case 'stop':
        await this.stop(op, context, false);
        return {};
      case 'remove_data':
        await this.stop(op, context, true);
        return {};
      case 'state':
        return { runtime: await this.deps.runtime.state(identityOf(op), this.adminCall(context)) };
    }
  }

  /** Starts the Previews whose desired state is running again, once the egress rules check out. */
  async resumeRunning(context: OperationContext): Promise<{ resumed: number; failed: number }> {
    const desired = await this.deps.desired.list();
    if (desired.length === 0) return { resumed: 0, failed: 0 };
    await this.deps.egress.verify(context.signal);
    const call = this.adminCall(context);
    let resumed = 0;
    let failed = 0;
    for (const preview of desired) {
      const layout = buildLayout(this.deps.dataDir, preview.projectId, preview.operationId);
      try {
        const content =
          preview.environmentFilePath === null
            ? null
            : await readFile(join(layout.srcDir, preview.environmentFilePath), 'utf8');
        const run: PreviewRun = {
          projectId: preview.projectId,
          composeProject: preview.composeProject,
          previewLabel: preview.previewLabel,
          layout,
          environment: composeEnvironment(this.base(layout), content).env,
          service: preview.service,
          port: preview.port,
        };
        await this.deps.runtime.start(run, call);
        resumed += 1;
      } catch {
        failed += 1;
      }
    }
    return { resumed, failed };
  }

  private base(layout: BuildLayout): ComposeBase {
    return { ...this.deps.compose, HOME: layout.homeDir, DOCKER_CONFIG: layout.dockerConfigDir };
  }

  private adminCall(context: OperationContext): RuntimeCall {
    return {
      signal: AbortSignal.any([context.signal, AbortSignal.timeout(ADMIN_TIMEOUT_MS)]),
      onLine: context.log,
      killGraceMs: this.deps.killGraceMs,
    };
  }

  private async stop(op: OperationPayload, context: OperationContext, removeData: boolean) {
    const identity = identityOf(op);
    const call = this.adminCall(context);
    await this.deps.desired.clear(op.projectId);
    await this.deps.runtime.removeContainers(identity, call);
    if (removeData) await this.deps.runtime.removeVolumes(identity, call);
    await this.deps.slices.remove(identity, call.signal);
    await rm(
      removeData
        ? previewRoot(this.deps.dataDir, op.projectId)
        : buildsDir(this.deps.dataDir, op.projectId),
      {
        recursive: true,
        force: true,
      },
    );
  }

  private async build(op: BuildPayload, context: OperationContext): Promise<OperationOutcome> {
    const { deps } = this;
    const layout = buildLayout(deps.dataDir, op.projectId, op.operationId);
    const deadline = AbortSignal.timeout(
      (deps.deadlineMs ?? ((minutes: number) => minutes * 60_000))(op.limits.buildMinutes),
    );
    const signal = AbortSignal.any([context.signal, deadline]);
    const call: RuntimeCall = { signal, onLine: context.log, killGraceMs: deps.killGraceMs };
    const identity = identityOf(op);
    let startAttempted = false;
    try {
      await this.prepareDirectories(layout);
      await this.checkFreeSpace(layout);
      context.log('controller', 'Fetching the source archive.');
      const summary = await this.unpack(op, layout, signal);
      context.log('controller', `Unpacked ${summary.entries} entries (${summary.files} files).`);
      signal.throwIfAborted();

      const text = await readComposeFile(layout.srcDir, op.composeFile);
      const validated = validateCompose({ text, entryService: op.service, entryPort: op.port });
      if (validated.status === 'refused') {
        throw new OperationFailure(
          'validation_refused',
          `The Compose file was refused (${validated.refusals.length} findings).`,
          validated.refusals
            .slice(0, PREVIEW_FAILURE_REFUSALS_MAX)
            .map(({ code, place, message }): PreviewRefusal => ({ code, place, message })),
        );
      }
      if (op.environmentFile) {
        await writeEnvironmentFile(
          layout.srcDir,
          op.environmentFile.path,
          op.environmentFile.content,
        );
      }
      await writeFile(layout.stackFile, renderStack(validated.stack), { mode: 0o600 });
      await writeFile(layout.overrideFile, renderOverride(validated.stack, identity), {
        mode: 0o600,
      });
      await writeFile(layout.emptyEnvFile, '', { mode: 0o600 });
      const { env, dropped } = composeEnvironment(
        this.base(layout),
        op.environmentFile?.content ?? null,
      );
      if (dropped.length > 0) {
        context.log('controller', `Environment file keys not passed on: ${dropped.join(', ')}.`);
      }
      const run: PreviewRun = {
        ...identity,
        layout,
        environment: env,
        service: op.service,
        port: op.port,
      };

      await deps.slices.apply(identity, op.limits, signal);
      await deps.slices.boundBuild(identity, op.limits, signal);
      await deps.egress.verify(signal);
      await deps.runtime.build(run, call);
      await deps.egress.verify(signal);
      startAttempted = true;
      await deps.runtime.start(run, call);
      await deps.desired.record({
        projectId: op.projectId,
        operationId: op.operationId,
        composeProject: op.composeProject,
        previewLabel: op.previewLabel,
        service: op.service,
        port: op.port,
        environmentFilePath: op.environmentFile?.path ?? null,
      });
      await removeOtherBuilds(deps.dataDir, op.projectId, op.operationId);
      return { runtime: await deps.runtime.state(identity, call) };
    } catch (error) {
      if (startAttempted) await this.rollBackStart(identity, op.projectId);
      await rm(layout.buildDir, { recursive: true, force: true }).catch(() => undefined);
      const failure = classify(error, deadline, context.signal);
      if (
        startAttempted &&
        (failure instanceof OperationFailure || failure instanceof OperationAborted)
      ) {
        failure.previewRemoved = true;
      }
      throw failure;
    }
  }

  /** After a failure past `up` nothing may keep running without a bridge: remove it as stop does. */
  private async rollBackStart(identity: PreviewIdentity, projectId: string): Promise<void> {
    const call: RuntimeCall = {
      signal: AbortSignal.timeout(ADMIN_TIMEOUT_MS),
      onLine: () => undefined,
      killGraceMs: this.deps.killGraceMs,
    };
    await this.deps.desired.clear(projectId).catch(() => undefined);
    await this.deps.runtime.removeContainers(identity, call).catch(() => undefined);
  }

  private async prepareDirectories(layout: BuildLayout): Promise<void> {
    await rm(layout.buildDir, { recursive: true, force: true });
    await mkdir(dirname(layout.previewRoot), { recursive: true, mode: 0o700 });
    await mkdir(layout.previewRoot, { recursive: true, mode: 0o700 });
    await chmod(layout.previewRoot, 0o700);
    await mkdir(layout.srcDir, { recursive: true, mode: 0o700 });
    await mkdir(layout.homeDir, { mode: 0o700 });
    await mkdir(layout.dockerConfigDir, { mode: 0o700 });
  }

  private async checkFreeSpace(layout: BuildLayout): Promise<void> {
    const free = await (this.deps.freeBytes ?? defaultFreeBytes)(layout.previewRoot);
    if (free < this.deps.minFreeBytes) {
      throw new OperationFailure('disk_full', 'There is not enough free disk space for a build.');
    }
  }

  private async unpack(op: BuildPayload, layout: BuildLayout, signal: AbortSignal) {
    const download = await abortable(this.deps.fetchSource(op.operationId, signal), signal);
    if (download.length !== null && download.length > PREVIEW_ARCHIVE_MAX_BYTES) {
      throw new OperationFailure('source_unavailable', 'The source archive is too large.');
    }
    return extractTar(download.stream, layout.srcDir, {
      maxBytes: PREVIEW_ARCHIVE_MAX_BYTES,
      maxEntries: PREVIEW_ARCHIVE_MAX_ENTRIES,
    });
  }
}

/** Settles with the promise, or rejects as aborted as soon as the signal aborts. */
function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(new OperationAborted());
    if (signal.aborted) return onAbort();
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', onAbort));
  });
}

/** A Compose file path the settings flow produced is checked again here. */
function composeFileSegments(path: string): string[] | null {
  const segments = path.split('/');
  const bad =
    path === '' ||
    path.length > 255 ||
    path.includes('\0') ||
    path.includes('\\') ||
    path.startsWith('/') ||
    segments.some((part) => part === '' || part === '.' || part === '..');
  return bad ? null : segments;
}

/** The text of the Compose file: a regular file inside the unpacked source, 256 KiB at most. */
async function readComposeFile(srcDir: string, path: string): Promise<string> {
  const missing = () =>
    new OperationFailure('compose_file_missing', 'The Compose file is not in the source.');
  const segments = composeFileSegments(path);
  if (!segments) throw missing();
  let real: string;
  try {
    real = await realpath(join(srcDir, ...segments));
  } catch {
    throw missing();
  }
  const inside = relative(await realpath(srcDir), real);
  if (inside === '' || inside === '..' || inside.startsWith(`..${sep}`)) throw missing();
  const info = await lstat(real);
  if (!info.isFile()) throw missing();
  if (info.size > MAX_TEXT_BYTES) {
    throw new OperationFailure('validation_refused', 'The Compose file is larger than the limit.', [
      {
        code: 'compose_file_too_large',
        place: 'composeFile',
        message: 'The Compose file is larger than the size limit.',
      },
    ]);
  }
  return readFile(real, 'utf8');
}

/** Removes the build directories of the Project except the one that now runs. */
async function removeOtherBuilds(dataDir: string, projectId: string, keep: string) {
  const root = buildsDir(dataDir, projectId);
  for (const name of await readdir(root).catch(() => [] as string[])) {
    if (name !== keep) await rm(join(root, name), { recursive: true, force: true });
  }
}

/** Maps what went wrong to the failure the controller reports, or to an abort. */
function classify(error: unknown, deadline: AbortSignal, outside: AbortSignal): Error {
  if (deadline.aborted) {
    return new OperationFailure('build_timed_out', 'The build ran over its time limit.');
  }
  if (outside.aborted || error instanceof OperationAborted) return new OperationAborted();
  if (error instanceof OperationFailure) return error;
  if (error instanceof ArchiveError) return new OperationFailure('archive_invalid', error.message);
  if (error instanceof StudioApiError) {
    if (error.status === 404) return error;
    if (
      error.status === 409 &&
      (error.problemType === CONTROLLER_PROBLEM_TYPES.operationNotHeld ||
        error.problemType === CONTROLLER_PROBLEM_TYPES.operationNotFound)
    ) {
      return error;
    }
    return new OperationFailure('source_unavailable', 'The source archive could not be fetched.');
  }
  if ((error as NodeJS.ErrnoException)?.code === 'ENOSPC') {
    return new OperationFailure('disk_full', 'The disk is full.');
  }
  return new OperationFailure('controller_error', 'The controller hit an unexpected error.');
}
