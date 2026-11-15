import {
  type ReportRunStateRequest,
  type ReportRunStepRequest,
  type RunPayload,
  runPayloadSchema,
  type RunStatesResponse,
  runStatesResponseSchema,
  type WorkerStatusReport,
} from '@agentic-studio/contracts';

/** Default timeout of one call to the Studio API. */
export const DEFAULT_TIMEOUT_MS = 30_000;

/** A worker route answered with an error status (problem+json); never carries the token. */
export class StudioApiError extends Error {
  constructor(
    readonly status: number,
    readonly path: string,
    readonly problemType?: string,
  ) {
    super(`The Studio API answered ${status} on ${path}${problemType ? ` (${problemType})` : ''}.`);
    this.name = 'StudioApiError';
  }
}

/** Whether the API says this worker no longer holds the Run (or the transition is gone). */
export function isRunLost(error: unknown): boolean {
  return error instanceof StudioApiError && (error.status === 409 || error.status === 404);
}

/** Request bodies without the worker id, which the client adds itself. */
type WithoutWorker<T> = T extends unknown ? Omit<T, 'workerId'> : never;

/**
 * The worker's side of the worker protocol (Issue #96): the routes under `/api/worker/`,
 * authenticated by the worker token, with the shared contract's shapes. The worker always
 * calls Studio; nothing calls the worker.
 */
export class StudioApi {
  constructor(
    private readonly options: {
      apiUrl: string;
      token: string;
      workerId: string;
      /** Longest wait for one call; then it is abandoned (default 30 s). */
      timeoutMs?: number;
      fetch?: typeof fetch;
    },
  ) {}

  /** The next Run to carry out, or `null` when none is eligible (204). */
  async claim(signal?: AbortSignal): Promise<RunPayload | null> {
    const response = await this.post('runs/claim', {}, signal);
    if (response.status === 204) return null;
    return runPayloadSchema.parse(await response.json());
  }

  async reportState(
    runId: string,
    report: WithoutWorker<ReportRunStateRequest>,
    signal?: AbortSignal,
  ): Promise<void> {
    await this.post(`runs/${encodeURIComponent(runId)}/state`, report, signal);
  }

  async reportStep(
    runId: string,
    step: WithoutWorker<ReportRunStepRequest>,
    signal?: AbortSignal,
  ): Promise<void> {
    await this.post(`runs/${encodeURIComponent(runId)}/steps`, step, signal);
  }

  /** The states of these Runs (1-500 ids); unknown ids are left out (Issue #98). */
  async runStates(runIds: readonly string[], signal?: AbortSignal): Promise<RunStatesResponse> {
    const response = await this.post('runs/states', { runIds }, signal);
    return runStatesResponseSchema.parse(await response.json());
  }

  /** Tells Studio this worker's runner mode and which providers it enables (Issue #101). */
  async reportStatus(status: WorkerStatusReport, signal?: AbortSignal): Promise<void> {
    await this.post('status', status, signal);
  }

  async heartbeat(runId: string, signal?: AbortSignal): Promise<void> {
    await this.post(`runs/${encodeURIComponent(runId)}/heartbeat`, {}, signal);
  }

  /**
   * One call: abandoned after the timeout, or when `signal` aborts (the worker stops). The
   * rejection is then the abort reason (a `TimeoutError` or `AbortError`).
   */
  private async post(path: string, body: object, signal?: AbortSignal): Promise<Response> {
    const { apiUrl, token, workerId } = this.options;
    const call = this.options.fetch ?? fetch;
    const response = await call(`${apiUrl}/api/worker/${path}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ workerId, ...body }),
      signal: AbortSignal.any([
        AbortSignal.timeout(this.options.timeoutMs ?? DEFAULT_TIMEOUT_MS),
        ...(signal ? [signal] : []),
      ]),
    });
    if (!response.ok) {
      const problem = (await response.json().catch(() => ({}))) as { type?: unknown };
      throw new StudioApiError(
        response.status,
        `/api/worker/${path}`,
        typeof problem.type === 'string' ? problem.type : undefined,
      );
    }
    return response;
  }
}
