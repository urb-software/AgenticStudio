import { vi } from 'vitest';
import type { ProblemDetails, ProjectOutput, RepositoryOutput } from '../../../platform/api';
import { problem } from './fake-projects-api';

interface ScriptedResponse {
  status: number;
  body: unknown;
}

type Route = 'project' | 'repository' | 'connect';

/**
 * A fake of the project detail API behind `fetch` (`GET /api/projects/:id`,
 * `GET|POST /api/projects/:id/repository`), so the generated client, the wrapper and TanStack
 * Query run for real. `repository` is the server's state; tests change it to move the
 * Repository on (as the background clone would) and script error responses.
 */
export function fakeProjectApi(project: ProjectOutput, initial: RepositoryOutput | null = null) {
  const state = { repository: initial };
  const scripted: Record<Route, ScriptedResponse[]> = { project: [], repository: [], connect: [] };
  const calls: { route: Route; body?: unknown }[] = [];

  const fetch = vi.fn(async (request: Request): Promise<Response> => {
    const { pathname } = new URL(request.url);
    const match = /^\/api\/projects\/([^/]+)(\/repository)?$/.exec(pathname);
    if (!match) return json(404, problem(404, 'Not Found'));
    const route: Route = !match[2]
      ? 'project'
      : request.method === 'POST'
        ? 'connect'
        : 'repository';
    const body: unknown = request.method === 'POST' ? await request.json() : undefined;
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
        state.repository = { state: 'connecting', url, integrationBranch };
        return json(201, state.repository);
      }
    }
  });
  vi.stubGlobal('fetch', fetch);

  return {
    state,
    /** Requests to one route, in order. */
    calls: (route: Route) => calls.filter((call) => call.route === route),
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
