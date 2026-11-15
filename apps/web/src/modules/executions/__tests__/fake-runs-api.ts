import { vi } from 'vitest';
import type {
  ProblemDetails,
  ProjectOutput,
  ProviderAvailabilityOutput,
  RunEventOutput,
  RunOutput,
  RunStepOutput,
} from '../../../platform/api';

type Route =
  | 'projects'
  | 'project'
  | 'projectRuns'
  | 'start'
  | 'runs'
  | 'run'
  | 'retryDelivery'
  | 'providers'
  | 'events'
  | 'steps'
  | 'stream';

interface ScriptedResponse {
  status: number;
  body: unknown;
}

const ROUTES: readonly [RegExp, (method: string) => Route][] = [
  [/^\/api\/projects()$/, () => 'projects'],
  [/^\/api\/projects\/([^/]+)$/, () => 'project'],
  [/^\/api\/projects\/([^/]+)\/runs$/, (method) => (method === 'POST' ? 'start' : 'projectRuns')],
  [/^\/api\/runs$/, () => 'runs'],
  [/^\/api\/runs\/([^/]+)$/, () => 'run'],
  [/^\/api\/runs\/([^/]+)\/retry-delivery$/, () => 'retryDelivery'],
  [/^\/api\/providers()$/, () => 'providers'],
  [/^\/api\/runs\/([^/]+)\/events$/, () => 'events'],
  [/^\/api\/runs\/([^/]+)\/steps$/, () => 'steps'],
  [/^\/api\/runs\/([^/]+)\/events\/stream$/, () => 'stream'],
];

/** One open live log connection of the fake: the test pushes events, ends or drops it. */
export interface FakeStream {
  runId: string;
  /** The `after` the client asked for. */
  after: number;
  push(...events: RunEventOutput[]): void;
  /** The Run is final and everything was sent (`event: end`). */
  end(): void;
  /** The connection breaks without `end`. */
  drop(): void;
  /** Whether the client aborted the request (e.g. the page went away). */
  aborted(): boolean;
}

export const PROJECT: ProjectOutput = {
  id: '00000000-0000-4000-8000-0000000000a1',
  name: 'Acme Shop',
  createdAt: '2026-11-12T09:00:00.000Z',
};

export const SHA = '0123456789abcdef0123456789abcdef01234567';

/** Both providers available: what `GET /api/providers` answers unless a test scripts it. */
export const BOTH_AVAILABLE: ProviderAvailabilityOutput[] = [
  { id: 'claude_code', name: 'Claude Code', available: true },
  { id: 'codex', name: 'Codex', available: true },
];

let nextRun = 1;

/** A Run of `PROJECT` with defaults; tests override what they look at. */
export function aRun(overrides: Partial<RunOutput> = {}): RunOutput {
  const n = nextRun++;
  return {
    id: `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`,
    projectId: PROJECT.id,
    provider: 'claude_code',
    task: `Task number ${n}`,
    state: 'queued',
    startCommit: SHA,
    createdAt: '2026-11-15T10:00:00.000Z',
    limits: { stepMinutes: 60, maxSteps: 10, waitingDays: 14 },
    ...overrides,
  };
}

/** A second project, which the fake does not list (its name is unknown to the UI). */
export const OTHER_PROJECT_ID = '00000000-0000-4000-8000-0000000000b2';

/**
 * A fake of the executions operator API behind `fetch` (`GET|POST /api/projects/:id/runs`,
 * `GET /api/runs`, `GET /api/runs/:runId`, `GET /api/providers`, and `GET /api/projects(/:id)`
 * for project names),
 * so the generated client, the wrapper and TanStack Query run for real. `runs` is the server's
 * state, newest first; tests change a Run's state (as the agent worker would) and script error
 * responses. It keeps the contract (201 with a `queued` Run) without the API's rules.
 */
export function fakeRunsApi(initial: RunOutput[] = []) {
  const runs = [...initial];
  const scripted: Record<Route, ScriptedResponse[]> = {
    projects: [],
    project: [],
    projectRuns: [],
    start: [],
    runs: [],
    run: [],
    retryDelivery: [],
    providers: [],
    events: [],
    steps: [],
    stream: [],
  };
  const calls: { route: Route; body?: unknown; query?: URLSearchParams }[] = [];
  /** Each Run's stored log and step results, as the API would hold them. */
  const logs = new Map<string, RunEventOutput[]>();
  const stepResults = new Map<string, RunStepOutput[]>();
  const streams: FakeStream[] = [];

  function openStream(runId: string, after: number, signal: AbortSignal): Response {
    const encoder = new TextEncoder();
    let controller!: ReadableStreamDefaultController<Uint8Array>;
    let closed = false;
    const close = () => {
      if (closed) return;
      closed = true;
      controller.close();
    };
    const body = new ReadableStream<Uint8Array>({
      start(c) {
        controller = c;
        c.enqueue(encoder.encode(': connected\n\n'));
      },
      cancel() {
        closed = true;
      },
    });
    let aborted = false;
    signal.addEventListener('abort', () => {
      aborted = true;
      close();
    });
    streams.push({
      runId,
      after,
      push(...events) {
        if (closed) return;
        for (const event of events) {
          controller.enqueue(
            encoder.encode(`id: ${event.seq}\ndata: ${JSON.stringify(event)}\n\n`),
          );
        }
      },
      end() {
        if (closed) return;
        controller.enqueue(encoder.encode('event: end\ndata: {}\n\n'));
        close();
      },
      drop: close,
      aborted: () => aborted,
    });
    return new Response(body, { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
  }

  const fetch = vi.fn(async (request: Request): Promise<Response> => {
    const { pathname, searchParams } = new URL(request.url);
    const matched = ROUTES.map(([pattern, route]) => [pattern.exec(pathname), route] as const).find(
      ([match]) => match,
    );
    if (!matched) return json(404, problem(404, 'Not Found'));
    const [match, routeOf] = matched;
    const route = routeOf(request.method);
    const id = match![1];
    const body: unknown = route === 'start' ? await request.json() : undefined;
    calls.push({ route, body, query: searchParams });
    const response = scripted[route].shift();
    if (response) return json(response.status, response.body);
    switch (route) {
      case 'projects':
        return json(200, { items: [PROJECT] });
      case 'project':
        return id === PROJECT.id
          ? json(200, { ...PROJECT, repository: null })
          : json(404, problem(404, 'Project not found'));
      case 'projectRuns':
        return json(
          200,
          runs.filter((run) => run.projectId === id),
        );
      case 'runs':
        return json(200, [...runs]);
      case 'providers':
        return json(200, BOTH_AVAILABLE);
      case 'run': {
        const run = runs.find((candidate) => candidate.id === id);
        return run ? json(200, run) : json(404, problem(404, 'Run not found'));
      }
      case 'retryDelivery': {
        const index = runs.findIndex((candidate) => candidate.id === id);
        if (index === -1) return json(404, problem(404, 'Run not found'));
        runs[index] = { ...runs[index]!, deliveryRetryRequested: true };
        return json(202, runs[index]);
      }
      case 'events': {
        const after = Number(searchParams.get('after') ?? 0);
        const limit = Number(searchParams.get('limit') ?? 500);
        const rest = (logs.get(id!) ?? []).filter((event) => event.seq > after);
        const events = rest.slice(0, limit);
        return json(200, rest.length > limit ? { events, next: events.at(-1)!.seq } : { events });
      }
      case 'steps':
        return json(200, { steps: stepResults.get(id!) ?? [] });
      case 'stream':
        return openStream(id!, Number(searchParams.get('after') ?? 0), request.signal);
      case 'start': {
        const { task, provider } = body as Pick<RunOutput, 'task' | 'provider'>;
        const run = aRun({
          projectId: id!,
          task: task.trim(),
          provider,
          createdAt: new Date().toISOString(),
        });
        runs.unshift(run);
        return json(201, run);
      }
    }
  });
  vi.stubGlobal('fetch', fetch);

  return {
    /** Requests to `route`, in order. */
    calls: (route: Route) => calls.filter((call) => call.route === route),
    /** The next request to `route` gets this response instead of the default. */
    respondNext(route: Route, status: number, body: unknown) {
      scripted[route].push({ status, body });
    },
    /** Moves a Run on, as the agent worker would. */
    update(runId: string, change: Partial<RunOutput>) {
      const index = runs.findIndex((run) => run.id === runId);
      runs[index] = { ...runs[index]!, ...change };
    },
    /** The server's Runs, newest first. */
    runs: () => [...runs],
    /** Stores events in a Run's log (what the paged read returns). */
    storeEvents(runId: string, ...events: RunEventOutput[]) {
      logs.set(runId, [...(logs.get(runId) ?? []), ...events]);
    },
    /** Sets a Run's step results. */
    setSteps(runId: string, steps: RunStepOutput[]) {
      stepResults.set(runId, steps);
    },
    /** The live log connections opened so far, in order. */
    streams: () => [...streams],
  };
}

export function problem(
  status: number,
  title: string,
  detail = `${title}.`,
  errors?: ProblemDetails['errors'],
): ProblemDetails {
  return {
    type: 'about:blank',
    title,
    status,
    detail,
    correlationId: '00000000-0000-4000-8000-00000000c0de',
    ...(errors ? { errors } : {}),
  };
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': status >= 400 ? 'application/problem+json' : 'application/json' },
  });
}

/** A Run event with defaults (an output line of step 1). */
export function anEvent(seq: number, overrides: Partial<RunEventOutput> = {}): RunEventOutput {
  return {
    seq,
    at: '2026-11-15T10:00:10.000Z',
    stepIndex: 1,
    kind: 'output',
    text: `line ${seq}`,
    ...overrides,
  };
}
