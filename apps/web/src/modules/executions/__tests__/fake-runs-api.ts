import { vi } from 'vitest';
import type {
  ProblemDetails,
  ProjectOutput,
  ProviderAvailabilityOutput,
  RunOutput,
} from '../../../platform/api';

type Route = 'projects' | 'project' | 'projectRuns' | 'start' | 'runs' | 'run' | 'providers';

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
  [/^\/api\/providers()$/, () => 'providers'],
];

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
    providers: [],
  };
  const calls: { route: Route; body?: unknown }[] = [];

  const fetch = vi.fn(async (request: Request): Promise<Response> => {
    const { pathname } = new URL(request.url);
    const matched = ROUTES.map(([pattern, route]) => [pattern.exec(pathname), route] as const).find(
      ([match]) => match,
    );
    if (!matched) return json(404, problem(404, 'Not Found'));
    const [match, routeOf] = matched;
    const route = routeOf(request.method);
    const id = match![1];
    const body: unknown = route === 'start' ? await request.json() : undefined;
    calls.push({ route, body });
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
