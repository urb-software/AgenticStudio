import {
  type AgentFolderResponse,
  agentFolderResponseSchema,
  type ClaimLookupsResponse,
  claimLookupsResponseSchema,
  type HeartbeatResponse,
  heartbeatResponseSchema,
  type LookupResultRequest,
  type RunEventInput,
  type ReportRunDiffRequest,
  type ReportRunStateRequest,
  type ReportRunStepRequest,
  type RunPayload,
  runPayloadSchema,
  type RunSkillsResponse,
  runSkillsResponseSchema,
  type RunStatesResponse,
  runStatesResponseSchema,
  WORKER_PROBLEM_TYPES,
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

/**
 * Whether the API says this worker no longer holds the Run: a 404, or a 409
 * whose problem type says so (`run-not-held`, or `step-limit-reached`, which failed the Run).
 * Any other 409, e.g. `illegal-run-transition`, is a refusal of that one report, not a loss.
 */
export function isRunLost(error: unknown): boolean {
  if (!(error instanceof StudioApiError)) return false;
  if (error.status === 404) return true;
  return (
    error.status === 409 &&
    (error.problemType === WORKER_PROBLEM_TYPES.runNotHeld ||
      error.problemType === WORKER_PROBLEM_TYPES.stepLimitReached)
  );
}

/**
 * Whether a failed call may succeed later: Studio did not answer (network error,
 * timeout) or answered with a server error. The worker keeps a Run step going through such an
 * outage and retries its reports; any other answer is definitive.
 */
export function isTransient(error: unknown): boolean {
  if (error instanceof StudioApiError) return error.status >= 500;
  // An abort by the worker itself (it stops) is not an outage.
  return !(error instanceof Error && error.name === 'AbortError');
}

/** Request bodies without the worker id, which the client adds itself. */
type WithoutWorker<T> = T extends unknown ? Omit<T, 'workerId'> : never;

/**
 * The worker's side of the worker protocol: the routes under `/api/worker/`,
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

  /**
   * Reports the Run's diffs after a Run step's result, or why they could not be
   * computed; Studio replaces the ones it stored.
   */
  async reportDiff(
    runId: string,
    report: WithoutWorker<ReportRunDiffRequest>,
    signal?: AbortSignal,
  ): Promise<void> {
    await this.post(`runs/${encodeURIComponent(runId)}/diff`, report, signal);
  }

  /**
   * The lookups waiting for a worker, up to five, claimed for this one; empty when
   * none is waiting (204). A claim not answered within two minutes goes to another worker.
   */
  async claimLookups(signal?: AbortSignal): Promise<ClaimLookupsResponse> {
    const response = await this.post('lookups/claim', {}, signal);
    if (response.status === 204) return [];
    return claimLookupsResponseSchema.parse(await response.json());
  }

  /** Reports what a claimed lookup found out, or why it could not. */
  async reportLookup(
    lookupId: string,
    answer: WithoutWorker<LookupResultRequest>,
    signal?: AbortSignal,
  ): Promise<void> {
    await this.post(`lookups/${encodeURIComponent(lookupId)}/result`, answer, signal);
  }

  /** Appends a batch of the Run's log events; a re-sent seq is ignored by Studio. */
  async appendEvents(runId: string, events: RunEventInput[], signal?: AbortSignal): Promise<void> {
    await this.post(`runs/${encodeURIComponent(runId)}/events`, { events }, signal);
  }

  /**
   * The states of these Runs (1-500 ids); unknown ids are left out. `removedRunIds` reports the
   * Runs whose Working copies retention removed.
   */
  async runStates(
    runIds: readonly string[],
    signal?: AbortSignal,
    removedRunIds?: readonly string[],
  ): Promise<RunStatesResponse> {
    const response = await this.post(
      'runs/states',
      { runIds, ...(removedRunIds && removedRunIds.length > 0 ? { removedRunIds } : {}) },
      signal,
    );
    return runStatesResponseSchema.parse(await response.json());
  }

  /**
   * The files of the agent folder this worker's Run recorded, at the commit it recorded; the worker
   * names neither. A refusal carries its problem type (`agent-folder-unavailable`, `-invalid`).
   */
  async agentFolder(runId: string, signal?: AbortSignal): Promise<AgentFolderResponse> {
    const response = await this.get(
      `runs/${encodeURIComponent(runId)}/agent-folder?workerId=${encodeURIComponent(this.options.workerId)}`,
      signal,
    );
    return agentFolderResponseSchema.parse(await response.json());
  }

  /**
   * The files of the skills this worker's Run recorded, at the commit it recorded; the worker names
   * neither a skill nor a commit. A refusal carries its problem type (`skills-unavailable`, `-invalid`).
   */
  async runSkills(runId: string, signal?: AbortSignal): Promise<RunSkillsResponse> {
    const response = await this.get(
      `runs/${encodeURIComponent(runId)}/skills?workerId=${encodeURIComponent(this.options.workerId)}`,
      signal,
    );
    return runSkillsResponseSchema.parse(await response.json());
  }

  /** Tells Studio this worker's runner mode and which providers it enables. */
  async reportStatus(status: WorkerStatusReport, signal?: AbortSignal): Promise<void> {
    await this.post('status', status, signal);
  }

  /** Renews the lease; the answer says whether the operator asked to cancel. */
  async heartbeat(runId: string, signal?: AbortSignal): Promise<HeartbeatResponse> {
    const response = await this.post(`runs/${encodeURIComponent(runId)}/heartbeat`, {}, signal);
    return heartbeatResponseSchema.parse(await response.json());
  }

  private post(path: string, body: object, signal?: AbortSignal): Promise<Response> {
    const { token, workerId } = this.options;
    return this.send(path, signal, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ workerId, ...body }),
    });
  }

  private get(path: string, signal?: AbortSignal): Promise<Response> {
    return this.send(path, signal, {
      method: 'GET',
      headers: { Authorization: `Bearer ${this.options.token}` },
    });
  }

  /**
   * One call: abandoned after the timeout, or when `signal` aborts (the worker stops). The
   * rejection is then the abort reason (a `TimeoutError` or `AbortError`).
   */
  private async send(
    path: string,
    signal: AbortSignal | undefined,
    init: { method: string; headers: Record<string, string>; body?: string },
  ): Promise<Response> {
    const { apiUrl } = this.options;
    const call = this.options.fetch ?? fetch;
    const response = await call(`${apiUrl}/api/worker/${path}`, {
      ...init,
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
