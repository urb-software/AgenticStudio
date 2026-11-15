import {
  type ReportRunStateRequest,
  type ReportRunStepRequest,
  type RunPayload,
  runPayloadSchema,
} from '@agentic-studio/contracts';

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
      fetch?: typeof fetch;
    },
  ) {}

  /** The next Run to carry out, or `null` when none is eligible (204). */
  async claim(): Promise<RunPayload | null> {
    const response = await this.post('runs/claim', {});
    if (response.status === 204) return null;
    return runPayloadSchema.parse(await response.json());
  }

  async reportState(runId: string, report: WithoutWorker<ReportRunStateRequest>): Promise<void> {
    await this.post(`runs/${encodeURIComponent(runId)}/state`, report);
  }

  async reportStep(runId: string, step: WithoutWorker<ReportRunStepRequest>): Promise<void> {
    await this.post(`runs/${encodeURIComponent(runId)}/steps`, step);
  }

  async heartbeat(runId: string): Promise<void> {
    await this.post(`runs/${encodeURIComponent(runId)}/heartbeat`, {});
  }

  private async post(path: string, body: object): Promise<Response> {
    const { apiUrl, token, workerId } = this.options;
    const call = this.options.fetch ?? fetch;
    const response = await call(`${apiUrl}/api/worker/${path}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ workerId, ...body }),
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
