import {
  type AppendOperationLogResponse,
  appendOperationLogResponseSchema,
  CONTROLLER_PROBLEM_TYPES,
  type OperationLogLine,
  type OperationPayload,
  operationPayloadSchema,
  type ReportOperationStateRequest,
} from '@agentic-studio/contracts';

/** A controller route answered with an error status (problem+json); never carries the token. */
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

/** A claim whose payload this controller cannot read; it is held, so it must be failed. */
export class InvalidClaimError extends Error {
  constructor(readonly operationId: string | null) {
    super('The Studio API sent an operation this controller cannot read.');
    this.name = 'InvalidClaimError';
  }
}

/** Whether the API says this controller no longer holds the operation (or it is final). */
export function isOperationLost(error: unknown): boolean {
  if (!(error instanceof StudioApiError)) return false;
  if (error.status === 404) return true;
  return error.status === 409 && error.problemType === CONTROLLER_PROBLEM_TYPES.operationNotHeld;
}

/** Whether a failed call may succeed later: no answer, or a server error. */
export function isTransient(error: unknown): boolean {
  if (error instanceof StudioApiError) return error.status >= 500;
  return !(error instanceof Error && error.name === 'AbortError');
}

export interface SourceDownload {
  /** The tar, as the API streams it. */
  stream: AsyncIterable<Uint8Array>;
  /** The `Content-Length` the API announced. */
  length: number | null;
}

export interface StudioApiOptions {
  apiUrl: string;
  token: string;
  controllerId: string;
  timeoutMs?: number;
  fetch?: typeof fetch;
}

const DEFAULT_TIMEOUT_MS = 30_000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The controller's side of the controller protocol: the routes under `/api/controller/`. */
export class StudioApi {
  constructor(private readonly options: StudioApiOptions) {}

  /** The next operation, or `null` when there is none (204). */
  async claim(signal?: AbortSignal): Promise<OperationPayload | null> {
    const response = await this.post('operations/claim', {}, signal);
    if (response.status === 204) return null;
    const body: unknown = await response.json();
    const parsed = operationPayloadSchema.safeParse(body);
    if (parsed.success) return parsed.data;
    const id = (body as { operationId?: unknown } | null)?.operationId;
    throw new InvalidClaimError(typeof id === 'string' && UUID.test(id) ? id : null);
  }

  async reportState(
    operationId: string,
    report: Omit<ReportOperationStateRequest, 'controllerId'>,
    signal?: AbortSignal,
  ): Promise<void> {
    await this.post(`operations/${encodeURIComponent(operationId)}/state`, report, signal);
  }

  async appendLog(
    operationId: string,
    lines: OperationLogLine[],
    signal?: AbortSignal,
  ): Promise<AppendOperationLogResponse> {
    const response = await this.post(
      `operations/${encodeURIComponent(operationId)}/log`,
      { lines },
      signal,
    );
    return appendOperationLogResponseSchema.parse(await response.json());
  }

  /** Starts the download of a build's source archive; `signal` also governs reading the body. */
  async fetchSource(operationId: string, signal?: AbortSignal): Promise<SourceDownload> {
    const { apiUrl, token, controllerId } = this.options;
    const path = `/api/controller/operations/${encodeURIComponent(operationId)}/source`;
    const call = this.options.fetch ?? fetch;
    const response = await call(
      `${apiUrl}${path}?controllerId=${encodeURIComponent(controllerId)}`,
      {
        headers: { Authorization: `Bearer ${token}`, Accept: 'application/x-tar' },
        signal,
      },
    );
    if (!response.ok || response.body === null) await this.fail(response, path);
    const length = Number(response.headers.get('content-length'));
    return {
      stream: response.body as unknown as AsyncIterable<Uint8Array>,
      length: Number.isSafeInteger(length) && length >= 0 ? length : null,
    };
  }

  private async post(path: string, body: object, signal?: AbortSignal): Promise<Response> {
    const { apiUrl, token, controllerId } = this.options;
    const call = this.options.fetch ?? fetch;
    const full = `/api/controller/${path}`;
    const response = await call(`${apiUrl}${full}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ controllerId, ...body }),
      signal: AbortSignal.any([
        AbortSignal.timeout(this.options.timeoutMs ?? DEFAULT_TIMEOUT_MS),
        ...(signal ? [signal] : []),
      ]),
    });
    if (!response.ok) await this.fail(response, full);
    return response;
  }

  private async fail(response: Response, path: string): Promise<never> {
    const problem = (await response.json().catch(() => ({}))) as { type?: unknown };
    throw new StudioApiError(
      response.status,
      path,
      typeof problem.type === 'string' ? problem.type : undefined,
    );
  }
}
