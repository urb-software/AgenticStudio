import {
  CONTROLLER_PROBLEM_TYPES,
  type OperationLogLine,
  type OperationPayload,
  type ReportOperationStateRequest,
} from '@agentic-studio/contracts';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EnvironmentController, type ControllerOperations } from '../controller.js';
import { DesiredStates } from '../desired-state.js';
import { OperationAborted, OperationFailure } from '../failure.js';
import { FakeRuntime } from '../fake-runtime.js';
import { JsonLineLogger, type ControllerLogger, type LogFields } from '../logger.js';
import { PreviewOperations } from '../preview-operations.js';
import { InvalidClaimError, StudioApiError } from '../studio-api.js';
import { chunked, file, tar } from './fixtures/tar-builder.js';

const PROJECT = '8f14e45f-ceea-467a-9575-1a3a8b1c0f10';
const COMPOSE_PROJECT = 'preview-8f14e45fceea467a95751a3a8b1c0f10';
const PASSWORD = 'pw-only-for-this-test-0123';
type Report = Omit<ReportOperationStateRequest, 'controllerId'>;

let counter = 0;
const op = (kind: OperationPayload['kind'] = 'state'): OperationPayload =>
  ({
    kind,
    operationId: `00000000-0000-4000-8000-${String(++counter).padStart(12, '0')}`,
    projectId: PROJECT,
    composeProject: COMPOSE_PROJECT,
    previewLabel: 'preview-8f14e45fceea',
  }) as OperationPayload;

class FakeApi {
  queue: (OperationPayload | Error | null)[] = [];
  reports: { id: string; report: Report }[] = [];
  logs: { id: string; lines: OperationLogLine[] }[] = [];
  claims = 0;
  reportError: (report: Report, n: number) => Error | undefined = () => undefined;
  private reportCalls = 0;

  async claim() {
    this.claims += 1;
    const next = this.queue.shift() ?? null;
    if (next instanceof Error) throw next;
    return next;
  }
  async reportState(id: string, report: Report) {
    this.reportCalls += 1;
    const error = this.reportError(report, this.reportCalls);
    if (error) throw error;
    this.reports.push({ id, report });
  }
  async appendLog(id: string, lines: OperationLogLine[]) {
    this.logs.push({ id, lines });
    return { stored: lines.length, truncated: false };
  }
  final(id: string) {
    return this.reports
      .filter((r) => r.id === id && r.report.state !== 'in_progress')
      .map((r) => r.report);
  }
}

class Recorder implements ControllerLogger {
  events: { name: string; fields: LogFields }[] = [];
  event(name: string, fields: LogFields = {}) {
    this.events.push({ name, fields });
  }
}

const operationsOf = (execute: ControllerOperations['execute']): ControllerOperations => ({
  execute,
  resumeRunning: async () => ({ resumed: 0, failed: 0 }),
});

async function until(check: () => boolean, ms = 5000) {
  const deadline = Date.now() + ms;
  while (!check()) {
    if (Date.now() > deadline) throw new Error('timed out');
    await delay(5);
  }
}

function start(
  api: FakeApi,
  operations: ControllerOperations,
  logger: ControllerLogger = new Recorder(),
) {
  const controller = new EnvironmentController({
    api: api as never,
    operations,
    logger,
    pollMs: 10,
    heartbeatMs: 20,
    logFlushMs: 10,
    report: { attempts: 4, delayMs: 5 },
  });
  void controller.run();
  return controller;
}

describe('EnvironmentController', () => {
  it('claims an operation, runs it and reports succeeded with the runtime', async () => {
    const api = new FakeApi();
    const claimed = op('state');
    api.queue.push(claimed);
    const controller = start(
      api,
      operationsOf(async (_op, ctx) => {
        ctx.log('controller', 'hello');
        return { runtime: { services: [{ name: 'web', state: 'running' }] } };
      }),
    );
    await until(() => api.final(claimed.operationId).length === 1);
    await controller.stop();
    expect(api.final(claimed.operationId)).toEqual([
      { state: 'succeeded', runtime: { services: [{ name: 'web', state: 'running' }] } },
    ]);
    expect(api.logs.flatMap((entry) => entry.lines.map((line) => line.text))).toEqual(['hello']);
  });

  it('keeps polling while there is nothing to do, one claim at a time', async () => {
    const api = new FakeApi();
    const controller = start(
      api,
      operationsOf(async () => ({})),
    );
    await until(() => api.claims >= 3);
    await controller.stop();
  });

  it('runs one operation at a time', async () => {
    const api = new FakeApi();
    const [first, second] = [op(), op()];
    api.queue.push(first, second);
    let running = 0;
    let most = 0;
    const controller = start(
      api,
      operationsOf(async () => {
        running += 1;
        most = Math.max(most, running);
        await delay(40);
        running -= 1;
        return {};
      }),
    );
    await until(() => api.final(second.operationId).length === 1);
    await controller.stop();
    expect(most).toBe(1);
  });

  it('reports a failure with its code, detail and refusals', async () => {
    const api = new FakeApi();
    const claimed = op('build');
    api.queue.push(claimed);
    const refusals = [{ code: 'privileged' as const, place: 'services.web', message: 'No.' }];
    const controller = start(
      api,
      operationsOf(async () => {
        throw new OperationFailure('validation_refused', 'The Compose file was refused.', refusals);
      }),
    );
    await until(() => api.final(claimed.operationId).length === 1);
    await controller.stop();
    expect(api.final(claimed.operationId)[0]).toEqual({
      state: 'failed',
      failure: { code: 'validation_refused', detail: 'The Compose file was refused.', refusals },
    });
  });

  it('reports previewRemoved when the failure removed the Preview', async () => {
    const api = new FakeApi();
    const claimed = op('build');
    api.queue.push(claimed);
    const controller = start(
      api,
      operationsOf(async () => {
        throw new OperationFailure('start_failed', 'The stack did not start.', undefined, true);
      }),
    );
    await until(() => api.final(claimed.operationId).length === 1);
    await controller.stop();
    expect(api.final(claimed.operationId)[0]).toEqual({
      state: 'failed',
      failure: { code: 'start_failed', detail: 'The stack did not start.', previewRemoved: true },
    });
  });

  it('reports previewRemoved with controller_stopped when the stop came after up', async () => {
    const api = new FakeApi();
    const claimed = op('build');
    api.queue.push(claimed);
    const controller = start(
      api,
      operationsOf(async () => {
        throw new OperationAborted(true);
      }),
    );
    await until(() => api.final(claimed.operationId).length === 1);
    await controller.stop();
    expect(api.final(claimed.operationId)[0]).toEqual({
      state: 'failed',
      failure: {
        code: 'controller_stopped',
        detail: 'The controller was stopped.',
        previewRemoved: true,
      },
    });
  });

  it('leaves previewRemoved out of a failure that removed nothing', async () => {
    const api = new FakeApi();
    const claimed = op('build');
    api.queue.push(claimed);
    const controller = start(
      api,
      operationsOf(async () => {
        throw new OperationFailure('build_failed', 'exit 1');
      }),
    );
    await until(() => api.final(claimed.operationId).length === 1);
    await controller.stop();
    expect(JSON.stringify(api.final(claimed.operationId)[0])).not.toContain('previewRemoved');
  });

  it('reports an unexpected error as controller_error without its message', async () => {
    const api = new FakeApi();
    const claimed = op();
    api.queue.push(claimed);
    const controller = start(
      api,
      operationsOf(async () => {
        throw new Error(`boom ${PASSWORD}`);
      }),
    );
    await until(() => api.final(claimed.operationId).length === 1);
    await controller.stop();
    const [report] = api.final(claimed.operationId);
    expect(report).toMatchObject({ state: 'failed', failure: { code: 'controller_error' } });
    expect(JSON.stringify(report)).not.toContain(PASSWORD);
  });

  it('sends a heartbeat while it works and stops when the operation ends', async () => {
    const api = new FakeApi();
    const claimed = op();
    api.queue.push(claimed);
    const controller = start(
      api,
      operationsOf(async () => (await delay(120), {})),
    );
    await until(() => api.final(claimed.operationId).length === 1);
    const beats = api.reports.filter((r) => r.report.state === 'in_progress').length;
    expect(beats).toBeGreaterThanOrEqual(3);
    await delay(80);
    expect(api.reports.filter((r) => r.report.state === 'in_progress').length).toBe(beats);
    await controller.stop();
  });

  it('abandons an operation the API no longer holds, with no final report', async () => {
    const api = new FakeApi();
    const claimed = op();
    api.queue.push(claimed);
    api.reportError = (report) =>
      report.state === 'in_progress'
        ? new StudioApiError(409, '/state', CONTROLLER_PROBLEM_TYPES.operationNotHeld)
        : undefined;
    const logger = new Recorder();
    let aborted = false;
    const controller = start(
      api,
      operationsOf(
        (_op, ctx) =>
          new Promise((_, reject) => {
            ctx.signal.addEventListener('abort', () => {
              aborted = true;
              reject(new OperationAborted());
            });
          }),
      ),
      logger,
    );
    await until(() => logger.events.some((event) => event.name === 'operation_lost'));
    await controller.stop();
    expect(aborted).toBe(true);
    expect(api.final(claimed.operationId)).toEqual([]);
  });

  it('abandons an operation whose log route says it is not held', async () => {
    const api = new FakeApi();
    const claimed = op();
    api.queue.push(claimed);
    api.appendLog = async () => {
      throw new StudioApiError(404, '/log');
    };
    const logger = new Recorder();
    const controller = start(
      api,
      operationsOf(async (_op, ctx) => (ctx.log('build', 'x'), await delay(60), {})),
      logger,
    );
    await until(() => logger.events.some((event) => event.name === 'operation_lost'));
    await controller.stop();
    expect(api.final(claimed.operationId)).toEqual([]);
  });

  it('retries the final report on transient errors and gives up on a 404 or 409', async () => {
    const api = new FakeApi();
    const [flaky, gone] = [op(), op()];
    api.queue.push(flaky, gone);
    let failures = 0;
    api.reportError = (report) => {
      if (report.state === 'in_progress') return undefined;
      if (failures < 2) {
        failures += 1;
        return new StudioApiError(503, '/state');
      }
      return undefined;
    };
    const controller = start(
      api,
      operationsOf(async () => ({})),
    );
    await until(() => api.final(flaky.operationId).length === 1);
    expect(failures).toBe(2);
    await controller.stop();

    const second = new FakeApi();
    const rejected = op();
    second.queue.push(rejected);
    let tries = 0;
    second.reportError = (report) => {
      if (report.state === 'in_progress') return undefined;
      tries += 1;
      return new StudioApiError(409, '/state', CONTROLLER_PROBLEM_TYPES.operationNotHeld);
    };
    const logger = new Recorder();
    const another = start(
      second,
      operationsOf(async () => ({})),
      logger,
    );
    await until(() => logger.events.some((event) => event.name === 'report_failed'));
    await another.stop();
    expect(tries).toBe(1);
  });

  it('reports controller_stopped for the operation in hand when it is stopped', async () => {
    const api = new FakeApi();
    const claimed = op('build');
    api.queue.push(claimed);
    let started = false;
    const controller = start(
      api,
      operationsOf(
        (_op, ctx) =>
          new Promise((_, reject) => {
            started = true;
            ctx.signal.addEventListener('abort', () => reject(new OperationAborted()));
          }),
      ),
    );
    await until(() => started);
    await controller.stop();
    expect(api.final(claimed.operationId)).toEqual([
      {
        state: 'failed',
        failure: { code: 'controller_stopped', detail: 'The controller was stopped.' },
      },
    ]);
  });

  it('fails an operation it cannot read, and goes on after a claim error', async () => {
    const api = new FakeApi();
    const id = '00000000-0000-4000-8000-0000000000ff';
    api.queue.push(
      new InvalidClaimError(id),
      new StudioApiError(500, '/claim'),
      new InvalidClaimError(null),
    );
    const logger = new Recorder();
    const controller = start(
      api,
      operationsOf(async () => ({})),
      logger,
    );
    await until(() => api.claims >= 4);
    await controller.stop();
    expect(api.final(id)).toEqual([
      {
        state: 'failed',
        failure: { code: 'controller_error', detail: 'The operation could not be read.' },
      },
    ]);
    expect(logger.events.map((event) => event.name)).toContain('claim_failed');
  });

  it('starts the Previews that were running before it claims, until that works', async () => {
    const api = new FakeApi();
    let attempts = 0;
    const logger = new Recorder();
    const controller = start(
      api,
      {
        execute: async () => ({}),
        resumeRunning: async () => {
          attempts += 1;
          if (attempts < 3) throw new OperationFailure('egress_rules_missing', 'no');
          return { resumed: 2, failed: 0 };
        },
      },
      logger,
    );
    await until(() => logger.events.some((event) => event.name === 'previews_resumed'));
    await controller.stop();
    expect(attempts).toBe(3);
    expect(logger.events.filter((event) => event.name === 'resume_blocked')).toHaveLength(1);
  });
});

describe('the controller writes no secret to its own log', () => {
  let dataDir: string;
  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), 'controller-loop-'));
  });
  afterEach(() => {
    vi.restoreAllMocks();
    rmSync(dataDir, { recursive: true, force: true });
  });

  it('keeps Environment values out of stdout, stderr and the journal lines, and sends them to the API only', async () => {
    const written: string[] = [];
    vi.spyOn(process.stdout, 'write').mockImplementation(
      (chunk: unknown) => (written.push(String(chunk)), true),
    );
    vi.spyOn(process.stderr, 'write').mockImplementation(
      (chunk: unknown) => (written.push(String(chunk)), true),
    );
    const journal: string[] = [];
    const logger = new JsonLineLogger((line) => journal.push(line));

    const fake = new FakeRuntime();
    const archive = tar(file('compose.yaml', 'services:\n  web:\n    image: nginx:1.27\n'));
    const operations = new PreviewOperations({
      dataDir,
      minFreeBytes: 1,
      killGraceMs: 10,
      compose: { PATH: '/usr/bin', DOCKER_HOST: 'unix:///x', XDG_RUNTIME_DIR: '/x' },
      fetchSource: async () => ({ stream: chunked(archive), length: archive.length }),
      runtime: fake,
      slices: fake,
      egress: fake,
      desired: new DesiredStates(dataDir),
    });
    const api = new FakeApi();
    const build = {
      ...op('build'),
      kind: 'build',
      commit: 'b'.repeat(40),
      composeFile: 'compose.yaml',
      service: 'web',
      port: 80,
      environmentFile: { path: '.env', content: `DB_PASSWORD=${PASSWORD}\n` },
      limits: { memoryMiB: 1024, cpuPercent: 100, tasksMax: 512, buildMinutes: 20 },
    } as OperationPayload;
    api.queue.push(build);
    const controller = start(api, operations, logger);
    await until(() => api.final(build.operationId).length === 1);
    await controller.stop();

    expect(api.final(build.operationId)[0]).toMatchObject({ state: 'succeeded' });
    // The fake's build output echoes the value, so it does reach the log route (the API redacts it there).
    expect(JSON.stringify(api.logs)).toContain(PASSWORD);
    expect(written.join('')).not.toContain(PASSWORD);
    expect(journal.join('\n')).not.toContain(PASSWORD);
    expect(journal.length).toBeGreaterThan(0);
    for (const line of journal) {
      expect(
        Object.keys(JSON.parse(line) as object).every((key) =>
          ['at', 'event', 'operationId', 'projectId', 'kind', 'outcome'].includes(key),
        ),
      ).toBe(true);
    }
  });
});
