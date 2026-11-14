import { vi } from 'vitest';
import type { ProblemDetails, ProjectOutput, RepositoryOutput } from '../../../platform/api';
import { problem } from './fake-projects-api';

interface ScriptedResponse {
  status: number;
  body: unknown;
}

type Route = 'project' | 'repository' | 'connect' | 'fetch' | 'disconnect';

/**
 * A fake of the project detail API behind `fetch` (`GET /api/projects/:id`,
 * `GET|POST|DELETE /api/projects/:id/repository`, `POST /api/projects/:id/repository/fetch`), so the
 * generated client, the wrapper and TanStack Query run for real. `repository` is the server's
 * state; tests change it to move the Repository on (as the background clone or fetch would)
 * and script error responses.
 */
export function fakeProjectApi(project: ProjectOutput, initial: RepositoryOutput | null = null) {
  /** `cleanupPending`: a disconnect cannot remove everything yet (202, `disconnecting`). */
  const state = { repository: initial, cleanupPending: false };
  const scripted: Record<Route, ScriptedResponse[]> = {
    project: [],
    repository: [],
    connect: [],
    fetch: [],
    disconnect: [],
  };
  const calls: { route: Route; body?: unknown }[] = [];
  const held: Partial<Record<Route, Promise<void>>> = {};

  const fetch = vi.fn(async (request: Request): Promise<Response> => {
    const response = await answer(request);
    const route = routeOf(request);
    const hold = route && held[route];
    if (route && hold) {
      delete held[route];
      await hold;
    }
    return response;
  });

  function routeOf(request: Request): Route | undefined {
    const match = /^\/api\/projects\/([^/]+)(\/repository(\/fetch)?)?$/.exec(
      new URL(request.url).pathname,
    );
    if (!match) return undefined;
    if (!match[2]) return 'project';
    if (match[3]) return 'fetch';
    if (request.method === 'DELETE') return 'disconnect';
    return request.method === 'POST' ? 'connect' : 'repository';
  }

  async function answer(request: Request): Promise<Response> {
    const { pathname } = new URL(request.url);
    const match = /^\/api\/projects\/([^/]+)(\/repository(\/fetch)?)?$/.exec(pathname);
    if (!match) return json(404, problem(404, 'Not Found'));
    const route = routeOf(request)!;
    const body: unknown = route === 'connect' ? await request.json() : undefined;
    calls.push({ route, body });
    const response = scripted[route].shift();
    if (response) return json(response.status, response.body);
    if (match[1] !== project.id) return json(404, problem(404, 'Project not found'));
    switch (route) {
      case 'project':
        return json(200, {
          ...project,
          repository: state.repository && {
            state: state.repository.state,
            url: state.repository.url,
            integrationBranch: state.repository.integrationBranch,
          },
        });
      case 'repository':
        return state.repository
          ? json(200, state.repository)
          : json(404, problem(404, 'No repository'));
      case 'connect': {
        const { url, integrationBranch } = body as { url: string; integrationBranch: string };
        state.repository = { state: 'connecting', url, integrationBranch, hasClone: false };
        return json(201, state.repository);
      }
      case 'fetch': {
        const current = state.repository;
        if (!current) return json(404, problem(404, 'No repository'));
        if (current.state !== 'ready' && !(current.state === 'failed' && current.hasClone)) {
          return json(409, problem(409, 'Repository busy'));
        }
        const { failure, ...rest } = current;
        void failure; // a fetch clears the previous failure
        state.repository = { ...rest, state: 'fetching' };
        return json(202, state.repository);
      }
      case 'disconnect': {
        const current = state.repository;
        if (!current) return json(404, problem(404, 'No repository'));
        if (state.cleanupPending) {
          state.repository = {
            state: 'disconnecting',
            url: current.url,
            integrationBranch: current.integrationBranch,
            hasClone: false,
          };
          return json(202, state.repository);
        }
        state.repository = null;
        return new Response(null, { status: 204 });
      }
    }
  }
  vi.stubGlobal('fetch', fetch);

  return {
    state,
    /** Requests to one route, in order. */
    calls: (route: Route) => calls.filter((call) => call.route === route),
    /**
     * Holds the answer to the next request to `route` (computed when the request arrives, so
     * it reflects the state at that time) until the returned function is called.
     */
    holdNext(route: Route): () => void {
      let release!: () => void;
      held[route] = new Promise<void>((resolve) => (release = resolve));
      return () => release();
    },
    /** The next request to `route` gets this response instead of the default. */
    respondNext(route: Route, status: number, body: unknown) {
      scripted[route].push({ status, body });
    },
  };
}

export function fieldProblem(
  status: number,
  title: string,
  errors: ProblemDetails['errors'],
  detail = 'The request is invalid.',
): ProblemDetails {
  return { ...problem(status, title, errors), detail };
}

function json(status: number, body: unknown): Response {
  const contentType = status >= 400 ? 'application/problem+json' : 'application/json';
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': contentType } });
}
